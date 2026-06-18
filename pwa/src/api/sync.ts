import type { Task, Project, TaskLink } from '@shared/types';
import { parseTaskRow } from '@shared/wire/rows';
import type { ApiConfig } from './client';
import { api } from './endpoints';
import { toRequest, rebindTaskId } from './pendingOps';
import type { PendingOp } from './pendingOps';
import { isDurableFailure } from './result';
import { messageFromResult, referencesTaskId, ATTEMPTS_CAP } from './syncPolicy';
import {
  idbGetAllTasks, idbPutTask, idbDeleteTask,
} from '../idb/tasks';
import {
  idbClearProjects, idbPutProject,
} from '../idb/projects';
import {
  idbClearLinks, idbPutLink,
} from '../idb/links';
import {
  idbGetPendingOps, idbDeletePendingOp, idbPutPendingOp,
} from '../idb/pendingOps';

export interface SyncResult {
  online: boolean;
  tasks?: Task[];
  projects?: Project[];
  links?: TaskLink[];
}

export interface FlushSummary {
  flushed: number;
  rejected: string[];
  halted: boolean;
}

// Surfaced once per app session when an op sits wedged at the attempts cap.
let _stuckNoticeFired = false;

export function _resetStuckNotice(): void {
  _stuckNoticeFired = false;
}

// Rebind all queued ops that reference oldId to newId.
async function rebindTempId(oldId: string, newId: string): Promise<void> {
  const pending = await idbGetPendingOps();
  for (const op of pending) {
    const rebound = rebindTaskId(op, oldId, newId);
    if (rebound !== op) await idbPutPendingOp(rebound);
  }
}

// Delete all queued ops that reference taskId. Returns the IDB ids that were
// deleted so the flush loop can skip them without re-fetching.
async function dropDependentOps(taskId: string): Promise<Set<number>> {
  const skipped = new Set<number>();
  const pending = await idbGetPendingOps();
  for (const op of pending) {
    if (referencesTaskId(op, taskId) && op.id !== undefined) {
      await idbDeletePendingOp(op.id);
      skipped.add(op.id);
    }
  }
  return skipped;
}

export async function flushPendingOps(config: ApiConfig): Promise<FlushSummary> {
  const ops = await idbGetPendingOps();
  let flushed = 0;
  const rejected: string[] = [];
  let halted = false;
  const skippedIds = new Set<number>();

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i]!;
    if (op.id !== undefined && skippedIds.has(op.id)) continue;

    const result = await toRequest(op, config);

    if (result.kind === 'contract') {
      // 2xx response whose body failed the schema check. The server has already
      // applied the write — drop the op to prevent retry duplication.
      console.error('[sync] contract violation on queued op; dropping', op.op);
      await idbDeletePendingOp(op.id!);
      if (op.op === 'task.create') {
        const raw = result.raw as Record<string, unknown> | undefined;
        const serverId = typeof raw?.['id'] === 'string' ? raw['id'] : null;
        if (serverId) {
          await rebindTempId(op.localId, serverId);
          for (let j = i + 1; j < ops.length; j++) {
            ops[j] = rebindTaskId(ops[j]!, op.localId, serverId);
          }
        }
      }
      flushed++;
      continue;
    }

    if (result.kind === 'ok') {
      if (op.op === 'task.create') {
        // Parse the server row BEFORE deleting the op so that a validation
        // failure doesn't leave the op gone with no rebinding done.
        const parsed = parseTaskRow(result.value);
        const oldId = op.localId;

        if (!parsed.ok) {
          console.error('[sync] offline-create response failed schema check', parsed.error);
          await idbDeletePendingOp(op.id!);
          const raw = result.value as Record<string, unknown>;
          const serverId = typeof raw?.['id'] === 'string' ? raw['id'] : null;
          if (serverId) {
            await rebindTempId(oldId, serverId);
            for (let j = i + 1; j < ops.length; j++) {
              ops[j] = rebindTaskId(ops[j]!, oldId, serverId);
            }
          }
          flushed++;
          continue;
        }

        const serverTask = parsed.value;
        const newId = serverTask.id;
        await idbDeletePendingOp(op.id!);
        await idbDeleteTask(oldId);
        await idbPutTask(serverTask);
        // Rebind in IDB and in the local array so subsequent ops in this cycle
        // use the real server ID, not the temp ID.
        await rebindTempId(oldId, newId);
        for (let j = i + 1; j < ops.length; j++) {
          ops[j] = rebindTaskId(ops[j]!, oldId, newId);
        }
      } else {
        await idbDeletePendingOp(op.id!);
      }
      flushed++;
      continue;
    }

    if (isDurableFailure(result)) {
      // 4xx rejection: the write can never succeed. Drop it and report to caller.
      rejected.push(messageFromResult(result));
      await idbDeletePendingOp(op.id!);

      if (op.op === 'task.create') {
        // All ops targeting this temp ID will also fail (the task will never
        // exist on the server), so drop them and mark them as skipped in the
        // current loop to avoid sending doomed requests.
        const newSkipped = await dropDependentOps(op.localId);
        for (const id of newSkipped) skippedIds.add(id);
        // The temp task has no pending create op protecting it, so syncFromServer
        // will delete it. Delete it from IDB now so the state is consistent even
        // if syncFromServer is skipped (e.g. we're offline).
        await idbDeleteTask(op.localId);
      }
      continue;
    }

    // Transient failure (network, 5xx, unconfigured): increment attempts and
    // stop the flush to preserve op ordering. Later ops are not attempted.
    const newAttempts = op.attempts + 1;
    await idbPutPendingOp({ ...op, attempts: newAttempts } as PendingOp);
    halted = true;

    if (newAttempts >= ATTEMPTS_CAP && !_stuckNoticeFired) {
      _stuckNoticeFired = true;
      rejected.push('Some changes aren\'t syncing — they may need to be redone.');
    }

    break;
  }

  return { flushed, rejected, halted };
}

export async function syncFromServer(config: ApiConfig): Promise<SyncResult> {
  const remote = await api.syncTasks(config);
  if (remote.kind !== 'ok') return { online: false };

  const remoteTasks = remote.value;
  const remoteMap = Object.fromEntries(remoteTasks.map(t => [t.id, t]));
  const pendingOps = await idbGetPendingOps();

  // A local task survives server-absence iff a pending task.create op carries
  // its id as localId. Title-based matching is intentionally removed here
  // (stage 5): two tasks with the same title both survive correctly.
  const offlineCreatedIds = new Set(
    pendingOps
      .filter((op): op is Extract<typeof op, { op: 'task.create' }> => op.op === 'task.create')
      .map(op => op.localId),
  );

  const local = await idbGetAllTasks();
  for (const lt of local) {
    if (!remoteMap[lt.id] && !offlineCreatedIds.has(lt.id)) {
      await idbDeleteTask(lt.id);
    }
  }
  for (const rt of remoteTasks) {
    await idbPutTask(rt);
  }

  const [projectsResult, linksResult] = await Promise.all([
    api.syncProjects(config),
    api.listLinks(config),
  ]);

  let projects: Project[] = [];
  let links: TaskLink[] = [];

  if (projectsResult.kind === 'ok') {
    projects = projectsResult.value;
    await idbClearProjects();
    for (const p of projects) await idbPutProject(p);
  }
  if (linksResult.kind === 'ok') {
    links = linksResult.value;
    await idbClearLinks();
    for (const l of links) await idbPutLink(l);
  }

  const finalTasks = await idbGetAllTasks();

  return { online: true, tasks: finalTasks, projects, links };
}
