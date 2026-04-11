import type { Dispatch } from 'react';
import type { Task, TaskLink, TaskUpdate } from '../types';
import type { AppAction } from './reducer';
import type { ApiConfig } from '../api/client';
import { apiFetch } from '../api/client';
import { idbGetAllTasks, idbPutTask, idbDeleteTask } from '../idb/tasks';
import { idbPutLink, idbDeleteLink } from '../idb/links';
import { idbQueueOp } from '../idb/pendingOps';
import { genId } from '../utils/genId';

export async function createTaskAction(
  title: string,
  config: ApiConfig,
  dispatch: Dispatch<AppAction>,
): Promise<void> {
  const now = new Date().toISOString();
  const task: Task = {
    id: genId('t'),
    title,
    notes: null,
    status: 'pending',
    due_date: null,
    recurrence: null,
    created_at: now,
    updated_at: now,
    snoozed_until: null,
    task_type: 'action',
    project_id: null,
    kickoff_note: null,
    session_log: null,
    focused_until: null,
  };
  await idbPutTask(task);
  dispatch({ type: 'UPSERT_TASK', task });

  const result = await apiFetch('/api/tasks', { method: 'POST', body: JSON.stringify({ title }) }, config);
  if (result) {
    const serverTask = result as Task;
    await idbDeleteTask(task.id);
    await idbPutTask(serverTask);
    dispatch({ type: 'DELETE_TASK', id: task.id });
    dispatch({ type: 'UPSERT_TASK', task: serverTask });
  } else {
    await idbQueueOp('POST', '/api/tasks', { title }, task.id);
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
  const updated: Task = { ...task, ...updates, updated_at: new Date().toISOString() };
  await idbPutTask(updated);
  dispatch({ type: 'UPSERT_TASK', task: updated });

  const result = await apiFetch(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(updates) }, config);
  if (!result) await idbQueueOp('PATCH', `/api/tasks/${id}`, updates);
}

export async function deleteTaskAction(
  id: string,
  config: ApiConfig,
  dispatch: Dispatch<AppAction>,
): Promise<void> {
  await idbDeleteTask(id);
  dispatch({ type: 'DELETE_TASK', id });

  const result = await apiFetch(`/api/tasks/${id}`, { method: 'DELETE' }, config);
  if (!result) await idbQueueOp('DELETE', `/api/tasks/${id}`, null);
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
  const updated: Task = { ...task, status: 'done', updated_at: new Date().toISOString() };
  await idbPutTask(updated);
  dispatch({ type: 'UPSERT_TASK', task: updated });

  const result = await apiFetch(`/api/tasks/${id}/complete`, { method: 'POST' }, config);
  if (result) {
    const res = result as { completed: Task; next?: Task };
    if (res.next) {
      await idbPutTask(res.next);
      dispatch({ type: 'UPSERT_TASK', task: res.next });
      return `Done! Next: <span class="next-date">${res.next.due_date}</span>`;
    }
  } else {
    await idbQueueOp('POST', `/api/tasks/${id}/complete`, null);
    if (wasRecurring) return 'Done! Next occurrence will sync when online.';
  }
  return null;
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
  const updated: Task = {
    ...task,
    focused_until: focusedUntil,
    updated_at: new Date().toISOString(),
  };
  await idbPutTask(updated);
  dispatch({ type: 'UPSERT_TASK', task: updated });

  const result = await apiFetch(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify({ focused_until: focusedUntil }) }, config);
  if (!result) await idbQueueOp('PATCH', `/api/tasks/${id}`, { focused_until: focusedUntil });
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

  const result = await apiFetch('/api/tasks/links', {
    method: 'POST',
    body: JSON.stringify({ from_task_id: fromId, to_task_id: toId, link_type: linkType }),
  }, config);
  if (!result) await idbQueueOp('POST', '/api/tasks/links', { from_task_id: fromId, to_task_id: toId, link_type: linkType });
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

  const result = await apiFetch('/api/tasks/links', {
    method: 'DELETE',
    body: JSON.stringify({ from_task_id: fromId, to_task_id: toId, link_type: linkType }),
  }, config);
  if (!result) await idbQueueOp('DELETE', '/api/tasks/links', { from_task_id: fromId, to_task_id: toId, link_type: linkType });
}
