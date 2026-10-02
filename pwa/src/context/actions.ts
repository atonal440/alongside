import type { Dispatch } from 'react';
import type { Task, TaskLink } from '../types';
import type { AppAction } from './reducer';
import type { ApiConfig } from '../api/client';
import type { PendingOpPayload } from '../api/pendingOps';
import type { IsoDateTime, NonEmptyString } from '@shared/parse';
import { idbQueueOp } from '../idb/pendingOps';
import { loadView } from '../sync/view';
import { genId } from '../utils/genId';
import {
  applyUpdate,
  applyComplete,
  applyDefer,
  applyClearDefer,
  applyFocus,
  applyUnfocus,
  applyReopen,
  type DeferInput,
  type LocalMutationError,
  type TaskUpdatePatch,
  type TaskWrite,
} from '../domain/taskMutations';
import type { Result } from '@shared/result';

// Registered by useSync so that actions can ask for a prompt sync after queueing a command.
let _requestSync: (() => void) | null = null;

export function registerSyncCallback(fn: () => void): void {
  _requestSync = fn;
}

export function requestSync(): void {
  _requestSync?.();
}

function nowIso(): IsoDateTime {
  return new Date().toISOString() as IsoDateTime;
}

// Every user write has one shape: queue the command, show the result of replaying the queue on the
// canonical state, and ask for a sync. The flush owns sending, ordering, retries and retaining
// refusals, so an action never talks to the server and the screen is always canonical + queue.
async function commit(ops: PendingOpPayload[], config: ApiConfig, dispatch: Dispatch<AppAction>): Promise<void> {
  for (const op of ops) await idbQueueOp(op);
  const view = await loadView(config.apiBase);
  dispatch({ type: 'SET_DATA', tasks: view.tasks, projects: view.projects, links: view.links });
  requestSync();
}

async function findTask(id: string, config: ApiConfig): Promise<Task | undefined> {
  return (await loadView(config.apiBase)).tasks.find(t => t.id === id);
}

// Run a pure mutation against the current task and queue its patch. A refused mutation (for
// example focusing a completed task) is reported without queueing anything.
async function mutate(
  id: string,
  config: ApiConfig,
  dispatch: Dispatch<AppAction>,
  apply: (task: Task) => Result<TaskWrite, LocalMutationError>,
): Promise<boolean> {
  const task = await findTask(id, config);
  if (!task) return false;
  const mutation = apply(task);
  if (!mutation.ok) {
    dispatch({ type: 'SET_TOAST', message: mutation.error.message });
    return false;
  }
  await commit([{ op: 'task.update', taskId: id, body: mutation.value.body }], config, dispatch);
  return true;
}

export async function createTaskAction(
  title: NonEmptyString<200>,
  config: ApiConfig,
  dispatch: Dispatch<AppAction>,
): Promise<void> {
  await commit([{ op: 'task.create', localId: genId('t'), body: { title } }], config, dispatch);
}

export async function updateTaskAction(
  id: string,
  updates: TaskUpdatePatch,
  config: ApiConfig,
  dispatch: Dispatch<AppAction>,
): Promise<void> {
  await mutate(id, config, dispatch, task => applyUpdate(task, updates, nowIso()));
}

export async function deleteTaskAction(
  id: string,
  config: ApiConfig,
  dispatch: Dispatch<AppAction>,
): Promise<void> {
  await commit([{ op: 'task.delete', taskId: id }], config, dispatch);
}

export async function completeTaskAction(
  id: string,
  config: ApiConfig,
  dispatch: Dispatch<AppAction>,
): Promise<string | null> {
  const task = await findTask(id, config);
  if (!task) return null;
  const mutation = applyComplete(task, nowIso());
  if (!mutation.ok) {
    dispatch({ type: 'SET_TOAST', message: mutation.error.message });
    return null;
  }
  await commit([{ op: 'task.complete', taskId: id }], config, dispatch);
  // The server creates the next occurrence; it arrives with the next sync.
  return mutation.value.wasRecurring ? 'Done! The next occurrence will appear after syncing.' : null;
}

export async function deferTaskAction(
  id: string,
  defer: DeferInput,
  config: ApiConfig,
  dispatch: Dispatch<AppAction>,
): Promise<void> {
  await mutate(id, config, dispatch, task => applyDefer(task, defer, nowIso()));
}

export async function clearDeferAction(
  id: string,
  config: ApiConfig,
  dispatch: Dispatch<AppAction>,
): Promise<void> {
  await mutate(id, config, dispatch, task => applyClearDefer(task, nowIso()));
}

export async function focusTaskAction(
  id: string,
  config: ApiConfig,
  dispatch: Dispatch<AppAction>,
  hours = 3,
): Promise<void> {
  await mutate(id, config, dispatch, task => applyFocus(task, hours, nowIso()));
}

export async function unfocusTaskAction(
  id: string,
  config: ApiConfig,
  dispatch: Dispatch<AppAction>,
): Promise<void> {
  await mutate(id, config, dispatch, task => applyUnfocus(task, nowIso()));
}

export async function reopenTaskAction(
  id: string,
  config: ApiConfig,
  dispatch: Dispatch<AppAction>,
): Promise<void> {
  await mutate(id, config, dispatch, task => applyReopen(task, nowIso()));
}

export async function createLinkAction(
  fromId: string,
  toId: string,
  linkType: TaskLink['link_type'],
  config: ApiConfig,
  dispatch: Dispatch<AppAction>,
): Promise<void> {
  await commit([{ op: 'link.create', body: { from_task_id: fromId, to_task_id: toId, link_type: linkType } }], config, dispatch);
}

export async function deleteLinkAction(
  fromId: string,
  toId: string,
  linkType: TaskLink['link_type'],
  config: ApiConfig,
  dispatch: Dispatch<AppAction>,
): Promise<void> {
  await commit([{ op: 'link.delete', body: { from_task_id: fromId, to_task_id: toId, link_type: linkType } }], config, dispatch);
}
