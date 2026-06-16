import type { Task, Project, TaskLink } from '@shared/types';
import { parseTaskRow } from '@shared/wire/rows';
import type { ApiConfig } from './client';
import { api } from './endpoints';
import { toRequest, rebindTaskId } from './pendingOps';
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

// Rebind all queued ops that reference oldId to newId.
async function rebindTempId(oldId: string, newId: string): Promise<void> {
  const pending = await idbGetPendingOps();
  for (const op of pending) {
    const rebound = rebindTaskId(op, oldId, newId);
    if (rebound !== op) await idbPutPendingOp(rebound);
  }
}

export async function flushPendingOps(config: ApiConfig): Promise<void> {
  const ops = await idbGetPendingOps();
  for (const op of ops) {
    const result = await toRequest(op, config);
    if (result.kind === 'contract') {
      // 2xx response with a non-JSON body (invalid_json contract): the server
      // applied the write but the response body is completely unusable. Drop the
      // op to prevent retry duplication. No server ID is available (raw is
      // undefined when JSON parsing itself fails), so dependent ops can't be
      // rebound here — stage 5 durable-failure handling will clean them up.
      console.error('[sync] 2xx with non-JSON body; dropping op to avoid retry', op.op);
      await idbDeletePendingOp(op.id!);
      continue;
    }

    if (result.kind === 'ok') {
      if (op.op === 'task.create') {
        // For offline-created tasks, parse the server row BEFORE deleting the op so
        // that a validation failure doesn't leave the op gone with no rebinding done.
        const parsed = parseTaskRow(result.value);
        const oldId = op.localId;

        if (!parsed.ok) {
          // Server created the task but returned an unrecognisable body.
          // Retrying would duplicate the server-side task, so drop the op.
          // Best-effort rebind: extract the raw `id` field so that any queued
          // PATCH/link ops are repointed to the real server ID rather than left
          // permanently targeting the stale temp ID.
          console.error('[sync] offline-create response failed schema check', parsed.error);
          await idbDeletePendingOp(op.id!);
          const raw = result.value as Record<string, unknown>;
          const serverId = typeof raw?.['id'] === 'string' ? raw['id'] : null;
          if (serverId) {
            await rebindTempId(oldId, serverId);
          }
          // If we couldn't extract an id at all, dependent ops will 404 on the
          // server; stage 5 durable-failure handling will clean them up.
          continue;
        }

        const serverTask = parsed.value;
        const newId = serverTask.id;
        await idbDeletePendingOp(op.id!);
        await idbDeleteTask(oldId);
        await idbPutTask(serverTask);
        await rebindTempId(oldId, newId);
      } else {
        await idbDeletePendingOp(op.id!);
      }
    }
  }
}

export async function syncFromServer(config: ApiConfig): Promise<SyncResult> {
  const remote = await api.syncTasks(config);
  if (remote.kind !== 'ok') return { online: false };

  const remoteTasks = remote.value;
  const remoteMap = Object.fromEntries(remoteTasks.map(t => [t.id, t]));
  const pendingOps = await idbGetPendingOps();

  // Keep offline-created tasks that haven't synced yet.
  // Stage 5 will replace title-based matching with localId-based survivor protection.
  const offlineCreatedTitles = new Set(
    pendingOps
      .filter(op => op.op === 'task.create')
      .map(op => op.body.title),
  );

  const local = await idbGetAllTasks();
  for (const lt of local) {
    if (!remoteMap[lt.id] && !offlineCreatedTitles.has(lt.title)) {
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

  // Merge offline tasks back in (they survived deletion above)
  const finalTasks = await idbGetAllTasks();

  return { online: true, tasks: finalTasks, projects, links };
}

