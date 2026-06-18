import type { Dispatch } from 'react';
import type { TaskLink } from '../types';
import type { AppAction } from './reducer';
import type { ApiConfig } from '../api/client';
import type { ApiResult } from '../api/result';
import type { TaskUpdateBody } from '../api/endpoints';
import type { IsoDateTime, NonEmptyString } from '@shared/parse';
import { api } from '../api/endpoints';
import { isTransientFailure } from '../api/result';
import { messageFromResult } from '../api/syncPolicy';
import { idbGetAllTasks, idbPutTask, idbDeleteTask } from '../idb/tasks';
import { idbPutLink, idbDeleteLink } from '../idb/links';
import { idbGetPendingOps, idbQueueOp } from '../idb/pendingOps';
import { genId } from '../utils/genId';
import {
  newLocalTask,
  applyUpdate,
  applyComplete,
  applyDefer,
  applyClearDefer,
  applyFocus,
  applyUnfocus,
  applyReopen,
  type DeferInput,
  type TaskUpdatePatch,
} from '../domain/taskMutations';

// Registered by useSync so that durable rejections can trigger a resync that
// rolls local state back to server truth (the rollback mechanism for optimistic
// writes — no per-op inverse operations needed).
let _requestSync: (() => void) | null = null;

export function registerSyncCallback(fn: () => void): void {
  _requestSync = fn;
}

// Queue only transient failures; durable rejections (4xx) are never retried.
// `unconfigured` behaves like offline — queue the op for later.
function shouldQueue(result: ApiResult<unknown>): boolean {
  return isTransientFailure(result) || result.kind === 'unconfigured';
}

// Returns true if `id` is the localId of a pending task.create op.
// Dependent writes on a temp-id task must be queued rather than sent directly:
// the server doesn't know the temp id yet, so any API call would get a 404
// (durable) and the write would be silently dropped instead of rebound after
// the create flushes.
async function hasPendingCreate(id: string): Promise<boolean> {
  const ops = await idbGetPendingOps();
  return ops.some(op => op.op === 'task.create' && op.localId === id);
}

// Dispatch a toast from a durable server rejection (4xx only) and trigger
// resync to restore server truth. `contract` results are excluded because the
// server applied the write despite the schema mismatch.
function handleRejection(result: ApiResult<unknown>, dispatch: Dispatch<AppAction>): void {
  if (result.kind !== 'http') return;
  dispatch({ type: 'SET_TOAST', message: messageFromResult(result) });
  _requestSync?.();
}

function nowIso(): IsoDateTime {
  return new Date().toISOString() as IsoDateTime;
}

export async function createTaskAction(
  title: string,
  config: ApiConfig,
  dispatch: Dispatch<AppAction>,
): Promise<void> {
  const now = nowIso();
  // Title parsing happens in stage 7; cast here until the form boundary is typed.
  const task = newLocalTask(title as NonEmptyString<200>, now, genId('t'));
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
  } else if (shouldQueue(result)) {
    await idbQueueOp({ op: 'task.create', localId: task.id, body: { title } });
  } else {
    // Durable server rejection (4xx). No pending create op means syncFromServer
    // will delete the temp task; resync is the rollback mechanism.
    handleRejection(result, dispatch);
  }
}

export async function updateTaskAction(
  id: string,
  updates: TaskUpdatePatch,
  config: ApiConfig,
  dispatch: Dispatch<AppAction>,
): Promise<void> {
  const tasks = await idbGetAllTasks();
  const task = tasks.find(t => t.id === id);
  if (!task) return;
  const mutation = applyUpdate(task, updates, nowIso());
  if (!mutation.ok) {
    dispatch({ type: 'SET_TOAST', message: mutation.error.message });
    return;
  }
  const { task: updated, body } = mutation.value;
  await idbPutTask(updated);
  dispatch({ type: 'UPSERT_TASK', task: updated });

  if (await hasPendingCreate(id)) {
    await idbQueueOp({ op: 'task.update', taskId: id, body: body as TaskUpdateBody });
    return;
  }
  const result = await api.updateTask(id, body, config);
  if (shouldQueue(result)) {
    await idbQueueOp({ op: 'task.update', taskId: id, body: body as TaskUpdateBody });
  } else {
    handleRejection(result, dispatch);
  }
}

export async function deleteTaskAction(
  id: string,
  config: ApiConfig,
  dispatch: Dispatch<AppAction>,
): Promise<void> {
  await idbDeleteTask(id);
  dispatch({ type: 'DELETE_TASK', id });

  if (await hasPendingCreate(id)) {
    await idbQueueOp({ op: 'task.delete', taskId: id });
    return;
  }
  const result = await api.deleteTask(id, config);
  if (shouldQueue(result)) {
    await idbQueueOp({ op: 'task.delete', taskId: id });
  } else {
    handleRejection(result, dispatch);
  }
}

export async function completeTaskAction(
  id: string,
  config: ApiConfig,
  dispatch: Dispatch<AppAction>,
): Promise<string | null> {
  const tasks = await idbGetAllTasks();
  const task = tasks.find(t => t.id === id);
  if (!task) return null;

  const mutation = applyComplete(task, nowIso());
  if (!mutation.ok) {
    dispatch({ type: 'SET_TOAST', message: mutation.error.message });
    return null;
  }
  const { task: updated, wasRecurring } = mutation.value;
  await idbPutTask(updated);
  dispatch({ type: 'UPSERT_TASK', task: updated });

  if (await hasPendingCreate(id)) {
    await idbQueueOp({ op: 'task.complete', taskId: id });
    if (wasRecurring) return 'Done! Next occurrence will sync when online.';
    return null;
  }
  const result = await api.completeTask(id, config);
  if (result.kind === 'ok') {
    if (result.value.next) {
      await idbPutTask(result.value.next);
      dispatch({ type: 'UPSERT_TASK', task: result.value.next });
      return `Done! Next: <span class="next-date">${result.value.next.due_date}</span>`;
    }
  } else if (shouldQueue(result)) {
    await idbQueueOp({ op: 'task.complete', taskId: id });
    if (wasRecurring) return 'Done! Next occurrence will sync when online.';
  } else {
    // Durable rejection (e.g. 409 invalid_transition — task already done).
    // Resync restores the correct server state.
    handleRejection(result, dispatch);
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
  const defer: DeferInput = kind === 'until' && untilIso
    ? { kind: 'until', until: untilIso as IsoDateTime }
    : { kind: 'someday' };
  const mutation = applyDefer(task, defer, nowIso());
  if (!mutation.ok) {
    dispatch({ type: 'SET_TOAST', message: mutation.error.message });
    return;
  }
  const { task: updated, body } = mutation.value;
  await idbPutTask(updated);
  dispatch({ type: 'UPSERT_TASK', task: updated });

  if (await hasPendingCreate(id)) {
    await idbQueueOp({ op: 'task.update', taskId: id, body });
    return;
  }
  const result = await api.updateTask(id, body, config);
  if (shouldQueue(result)) {
    await idbQueueOp({ op: 'task.update', taskId: id, body });
  } else {
    handleRejection(result, dispatch);
  }
}

export async function clearDeferAction(
  id: string,
  config: ApiConfig,
  dispatch: Dispatch<AppAction>,
): Promise<void> {
  const tasks = await idbGetAllTasks();
  const task = tasks.find(t => t.id === id);
  if (!task) return;
  const mutation = applyClearDefer(task, nowIso());
  if (!mutation.ok) {
    dispatch({ type: 'SET_TOAST', message: mutation.error.message });
    return;
  }
  const { task: updated, body } = mutation.value;
  await idbPutTask(updated);
  dispatch({ type: 'UPSERT_TASK', task: updated });

  if (await hasPendingCreate(id)) {
    await idbQueueOp({ op: 'task.update', taskId: id, body });
    return;
  }
  const result = await api.updateTask(id, body, config);
  if (shouldQueue(result)) {
    await idbQueueOp({ op: 'task.update', taskId: id, body });
  } else {
    handleRejection(result, dispatch);
  }
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
  const mutation = applyFocus(task, hours, nowIso());
  if (!mutation.ok) {
    dispatch({ type: 'SET_TOAST', message: mutation.error.message });
    return;
  }
  const { task: updated, body } = mutation.value;
  await idbPutTask(updated);
  dispatch({ type: 'UPSERT_TASK', task: updated });

  if (await hasPendingCreate(id)) {
    await idbQueueOp({ op: 'task.update', taskId: id, body });
    return;
  }
  const result = await api.updateTask(id, body, config);
  if (shouldQueue(result)) {
    await idbQueueOp({ op: 'task.update', taskId: id, body });
  } else {
    handleRejection(result, dispatch);
  }
}

export async function unfocusTaskAction(
  id: string,
  config: ApiConfig,
  dispatch: Dispatch<AppAction>,
): Promise<void> {
  const tasks = await idbGetAllTasks();
  const task = tasks.find(t => t.id === id);
  if (!task) return;
  const mutation = applyUnfocus(task, nowIso());
  if (!mutation.ok) {
    dispatch({ type: 'SET_TOAST', message: mutation.error.message });
    return;
  }
  const { task: updated, body } = mutation.value;
  await idbPutTask(updated);
  dispatch({ type: 'UPSERT_TASK', task: updated });

  if (await hasPendingCreate(id)) {
    await idbQueueOp({ op: 'task.update', taskId: id, body });
    return;
  }
  const result = await api.updateTask(id, body, config);
  if (shouldQueue(result)) {
    await idbQueueOp({ op: 'task.update', taskId: id, body });
  } else {
    handleRejection(result, dispatch);
  }
}

export async function reopenTaskAction(
  id: string,
  config: ApiConfig,
  dispatch: Dispatch<AppAction>,
): Promise<void> {
  const tasks = await idbGetAllTasks();
  const task = tasks.find(t => t.id === id);
  if (!task) return;
  const mutation = applyReopen(task, nowIso());
  if (!mutation.ok) {
    dispatch({ type: 'SET_TOAST', message: mutation.error.message });
    return;
  }
  const { task: updated, body } = mutation.value;
  await idbPutTask(updated);
  dispatch({ type: 'UPSERT_TASK', task: updated });

  if (await hasPendingCreate(id)) {
    await idbQueueOp({ op: 'task.update', taskId: id, body });
    return;
  }
  const result = await api.updateTask(id, body, config);
  if (shouldQueue(result)) {
    await idbQueueOp({ op: 'task.update', taskId: id, body });
  } else {
    handleRejection(result, dispatch);
  }
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
  if (await hasPendingCreate(fromId) || await hasPendingCreate(toId)) {
    await idbQueueOp({ op: 'link.create', body });
    return;
  }
  const result = await api.createLink(body, config);
  if (shouldQueue(result)) {
    await idbQueueOp({ op: 'link.create', body });
  } else {
    // Durable rejection (e.g. 409 for self-link or blocks cycle): the optimistic
    // link is removed by the resync triggered inside handleRejection.
    handleRejection(result, dispatch);
  }
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
  if (await hasPendingCreate(fromId) || await hasPendingCreate(toId)) {
    await idbQueueOp({ op: 'link.delete', body });
    return;
  }
  const result = await api.deleteLink(body, config);
  if (shouldQueue(result)) {
    await idbQueueOp({ op: 'link.delete', body });
  } else {
    handleRejection(result, dispatch);
  }
}
