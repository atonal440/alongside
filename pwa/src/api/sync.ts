import * as v from 'valibot';
import type { Task, Project, TaskLink } from '@shared/types';
import { parseSchema } from '@shared/parse';
import { parseTaskRow } from '@shared/wire/rows';
import { apiRequest, type ApiConfig } from './client';
import { api } from './endpoints';
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

// Passthrough parser for the generic pending-op replay loop.
const anyJson = (raw: unknown) => parseSchema(v.unknown(), raw);

export async function flushPendingOps(config: ApiConfig): Promise<void> {
  const ops = await idbGetPendingOps();
  for (const op of ops) {
    const result = await apiRequest(
      op.path,
      { method: op.method, body: op.body ? JSON.stringify(op.body) : undefined },
      config,
      anyJson,
    );
    if (result.kind === 'ok') {
      // For offline-created tasks, parse the server row BEFORE deleting the op so
      // that a validation failure doesn't leave the op gone with no rebinding done.
      if (op.method === 'POST' && op.path === '/api/tasks' && op.local_id) {
        const parsed = parseTaskRow(result.value);
        if (!parsed.ok) {
          // Server created the task but returned an unrecognisable body.
          // Drop the op anyway — retrying would duplicate the server-side task.
          // syncFromServer will reconcile the temp task on the next pull.
          console.error('[sync] offline-create response failed schema check; dropping op', parsed.error);
          await idbDeletePendingOp(op.id!);
          continue;
        }
        const serverTask = parsed.value;
        const oldId = op.local_id;
        const newId = serverTask.id;
        await idbDeletePendingOp(op.id!);
        await idbDeleteTask(oldId);
        await idbPutTask(serverTask);
        const remaining = await idbGetPendingOps();
        for (const pending of remaining) {
          let changed = false;
          if (typeof pending.path === 'string' && pending.path.includes(oldId)) {
            pending.path = pending.path.replace(oldId, newId);
            changed = true;
          }
          if (pending.body && typeof pending.body === 'object') {
            const body = pending.body as Record<string, unknown>;
            if (body.from_task_id === oldId) { body.from_task_id = newId; changed = true; }
            if (body.to_task_id === oldId) { body.to_task_id = newId; changed = true; }
            if (body.task_id === oldId) { body.task_id = newId; changed = true; }
          }
          if (changed) await idbPutPendingOp(pending);
        }
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

  // Keep offline-created tasks that haven't synced yet
  const offlineCreatedTitles = new Set(
    pendingOps
      .filter(op => op.method === 'POST' && op.path === '/api/tasks')
      .map(op => (op.body as { title?: string })?.title),
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
