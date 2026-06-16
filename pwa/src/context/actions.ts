import type { Dispatch } from 'react';
import type { TaskLink, TaskUpdate } from '../types';
import type { AppAction } from './reducer';
import type { ApiConfig } from '../api/client';
import { api } from '../api/endpoints';
import { idbGetAllTasks, idbPutTask, idbDeleteTask } from '../idb/tasks';
import { idbPutLink, idbDeleteLink } from '../idb/links';
import { idbQueueOp } from '../idb/pendingOps';
import { genId } from '../utils/genId';

// Failure classification used for pending-op queueing in this stage.
// `contract` must not enqueue — the server has already applied the write and
// a retry would duplicate it. Stage 5 handles durable vs. transient policy.
function shouldQueue(kind: string): boolean {
  return kind === 'http' || kind === 'network' || kind === 'unconfigured';
}

export async function createTaskAction(
  title: string,
  config: ApiConfig,
  dispatch: Dispatch<AppAction>,
): Promise<void> {
  const now = new Date().toISOString();
  const task = {
    id: genId('t'),
    title,
    notes: null,
    status: 'pending' as const,
    due_date: null,
    recurrence: null,
    created_at: now,
    updated_at: now,
    defer_until: null,
    defer_kind: 'none' as const,
    task_type: 'action' as const,
    project_id: null,
    kickoff_note: null,
    session_log: null,
    focused_until: null,
  };
  await idbPutTask(task);
  dispatch({ type: 'UPSERT_TASK', task });

  const result = await api.createTask({ title }, config);
  if (result.kind === 'ok') {
    const serverTask = result.value;
    await idbDeleteTask(task.id);
    await idbPutTask(serverTask);
    dispatch({ type: 'DELETE_TASK', id: task.id });
    dispatch({ type: 'UPSERT_TASK', task: serverTask });
  } else if (result.kind === 'contract') {
    // Server applied the write but the body failed schema validation.
    // Don't queue a retry (would duplicate the task). Best-effort: extract
    // the raw id field and update the local task so any follow-up edits,
    // links, or deletes reference the real server ID rather than the temp ID.
    const raw = result.raw as Record<string, unknown> | undefined;
    const serverId = typeof raw?.['id'] === 'string' ? raw['id'] : null;
    if (serverId) {
      const reidentified = { ...task, id: serverId };
      await idbDeleteTask(task.id);
      await idbPutTask(reidentified);
      dispatch({ type: 'DELETE_TASK', id: task.id });
      dispatch({ type: 'UPSERT_TASK', task: reidentified });
    }
    // If we can't extract an id, leave the temp task; syncFromServer reconciles it.
  } else if (shouldQueue(result.kind)) {
    await idbQueueOp({ op: 'task.create', localId: task.id, body: { title } });
  }
}

export async function updateTaskAction(
  id: string,
  updates: TaskUpdate,
  config: ApiConfig,
  dispatch: Dispatch<AppAction>,
): Promise<void> {
  const tasks = await idbGetAllTasks();
  const task = tasks.find(t => t.id === id);
  if (!task) return;
  const updated = { ...task, ...updates, updated_at: new Date().toISOString() };
  await idbPutTask(updated);
  dispatch({ type: 'UPSERT_TASK', task: updated });

  const result = await api.updateTask(id, updates, config);
  if (shouldQueue(result.kind)) await idbQueueOp({ op: 'task.update', taskId: id, body: updates });
}

export async function deleteTaskAction(
  id: string,
  config: ApiConfig,
  dispatch: Dispatch<AppAction>,
): Promise<void> {
  await idbDeleteTask(id);
  dispatch({ type: 'DELETE_TASK', id });

  const result = await api.deleteTask(id, config);
  if (shouldQueue(result.kind)) await idbQueueOp({ op: 'task.delete', taskId: id });
}

export async function completeTaskAction(
  id: string,
  config: ApiConfig,
  dispatch: Dispatch<AppAction>,
): Promise<string | null> {
  const tasks = await idbGetAllTasks();
  const task = tasks.find(t => t.id === id);
  if (!task) return null;

  const wasRecurring = !!task.recurrence;
  const updated = { ...task, status: 'done' as const, updated_at: new Date().toISOString() };
  await idbPutTask(updated);
  dispatch({ type: 'UPSERT_TASK', task: updated });

  const result = await api.completeTask(id, config);
  if (result.kind === 'ok') {
    if (result.value.next) {
      await idbPutTask(result.value.next);
      dispatch({ type: 'UPSERT_TASK', task: result.value.next });
      return `Done! Next: <span class="next-date">${result.value.next.due_date}</span>`;
    }
  } else if (shouldQueue(result.kind)) {
    await idbQueueOp({ op: 'task.complete', taskId: id });
    if (wasRecurring) return 'Done! Next occurrence will sync when online.';
  }
  return null;
}

export async function deferTaskAction(
  id: string,
  kind: 'until' | 'someday',
  untilIso: string | null,
  config: ApiConfig,
  dispatch: Dispatch<AppAction>,
): Promise<void> {
  const tasks = await idbGetAllTasks();
  const task = tasks.find(t => t.id === id);
  if (!task) return;
  const updates: TaskUpdate = {
    defer_kind: kind,
    defer_until: kind === 'until' ? untilIso : null,
    focused_until: null,
  };
  const updated = { ...task, ...updates, updated_at: new Date().toISOString() };
  await idbPutTask(updated);
  dispatch({ type: 'UPSERT_TASK', task: updated });

  const result = await api.updateTask(id, updates, config);
  if (shouldQueue(result.kind)) await idbQueueOp({ op: 'task.update', taskId: id, body: updates });
}

export async function clearDeferAction(
  id: string,
  config: ApiConfig,
  dispatch: Dispatch<AppAction>,
): Promise<void> {
  const tasks = await idbGetAllTasks();
  const task = tasks.find(t => t.id === id);
  if (!task) return;
  const updates: TaskUpdate = { defer_kind: 'none', defer_until: null };
  const updated = { ...task, ...updates, updated_at: new Date().toISOString() };
  await idbPutTask(updated);
  dispatch({ type: 'UPSERT_TASK', task: updated });

  const result = await api.updateTask(id, updates, config);
  if (shouldQueue(result.kind)) await idbQueueOp({ op: 'task.update', taskId: id, body: updates });
}

export async function focusTaskAction(
  id: string,
  config: ApiConfig,
  dispatch: Dispatch<AppAction>,
  hours = 3,
): Promise<void> {
  const tasks = await idbGetAllTasks();
  const task = tasks.find(t => t.id === id);
  if (!task) return;
  const focusedUntil = new Date(Date.now() + hours * 3600000).toISOString();
  const updated = {
    ...task,
    focused_until: focusedUntil,
    updated_at: new Date().toISOString(),
  };
  await idbPutTask(updated);
  dispatch({ type: 'UPSERT_TASK', task: updated });

  const body = { focused_until: focusedUntil };
  const result = await api.updateTask(id, body, config);
  if (shouldQueue(result.kind)) await idbQueueOp({ op: 'task.update', taskId: id, body });
}

export async function createLinkAction(
  fromId: string,
  toId: string,
  linkType: TaskLink['link_type'],
  config: ApiConfig,
  dispatch: Dispatch<AppAction>,
): Promise<void> {
  const link: TaskLink = { from_task_id: fromId, to_task_id: toId, link_type: linkType };
  await idbPutLink(link);
  dispatch({ type: 'UPSERT_LINK', link });

  const body = { from_task_id: fromId, to_task_id: toId, link_type: linkType };
  const result = await api.createLink(body, config);
  if (shouldQueue(result.kind)) await idbQueueOp({ op: 'link.create', body });
}

export async function deleteLinkAction(
  fromId: string,
  toId: string,
  linkType: TaskLink['link_type'],
  config: ApiConfig,
  dispatch: Dispatch<AppAction>,
): Promise<void> {
  await idbDeleteLink(fromId, toId, linkType);
  dispatch({ type: 'DELETE_LINK', from: fromId, to: toId, linkType });

  const body = { from_task_id: fromId, to_task_id: toId, link_type: linkType };
  const result = await api.deleteLink(body, config);
  if (shouldQueue(result.kind)) await idbQueueOp({ op: 'link.delete', body });
}
