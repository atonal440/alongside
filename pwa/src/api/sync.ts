import type { Task, Project, TaskLink, Duty } from '@shared/types';
import { apiFetch, type ApiConfig } from './client';
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
  idbClearDuties, idbPutDuty,
} from '../idb/duties';
import {
  idbGetPendingOps, idbDeletePendingOp, idbPutPendingOp,
} from '../idb/pendingOps';

export interface SyncResult {
  online: boolean;
  tasks?: Task[];
  projects?: Project[];
  links?: TaskLink[];
  duties?: Duty[];
}

export async function flushPendingOps(config: ApiConfig): Promise<void> {
  const ops = await idbGetPendingOps();
  for (const op of ops) {
    const result = await apiFetch(
      op.path,
      { method: op.method, body: op.body ? JSON.stringify(op.body) : undefined },
      config,
    );
    if (result !== null) {
      await idbDeletePendingOp(op.id!);

      // If an offline-created task just synced, rewrite queued ops referencing the temp ID
      if (op.method === 'POST' && op.path === '/api/tasks' && op.local_id) {
        const serverTask = result as Task;
        const oldId = op.local_id;
        const newId = serverTask.id;
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
      }
    }
  }
}

export async function syncFromServer(config: ApiConfig): Promise<SyncResult> {
  const remote = await apiFetch('/api/tasks/sync', {}, config);
  if (!remote) return { online: false };

  const remoteTasks = remote as Task[];
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

  const [projectsRaw, linksRaw, dutiesRaw] = await Promise.all([
    apiFetch('/api/projects/sync', {}, config),
    apiFetch('/api/tasks/links', {}, config),
    apiFetch('/api/duties', {}, config),
  ]);

  let projects: Project[] = [];
  let links: TaskLink[] = [];
  let duties: Duty[] = [];

  if (projectsRaw) {
    projects = projectsRaw as Project[];
    await idbClearProjects();
    for (const p of projects) await idbPutProject(p);
  }
  if (linksRaw) {
    links = linksRaw as TaskLink[];
    await idbClearLinks();
    for (const l of links) await idbPutLink(l);
  }
  if (dutiesRaw) {
    duties = dutiesRaw as Duty[];
    await idbClearDuties();
    for (const d of duties) await idbPutDuty(d);
  }

  // Merge offline tasks back in (they survived deletion above)
  const finalTasks = await idbGetAllTasks();

  return { online: true, tasks: finalTasks, projects, links, duties };
}
