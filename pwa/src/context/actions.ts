import type { Dispatch } from 'react';
import type { Task, TaskLink } from '../types';
import type { AppAction } from './reducer';
import type { ApiConfig } from '../api/client';
import type { IsoDateTime, NonEmptyString } from '@shared/parse';
import { idbGetPendingOps, idbQueueOp } from '../idb/pendingOps';
import { loadView } from '../sync/view';
import { currentWorkspace } from '../sync/pull';
import { predictBase } from '../sync/base';
import { intentsFromPatch, intentWrites, type Intent } from '../sync/intent';
import { genId } from '../utils/genId';
import {
  applyUpdate,
  applyComplete,
  applyDefer,
  applyClearDefer,
  applyFocus,
  applyUnfocus,
  applyReopen,
  subtasksOf,
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

// Every user write has one shape: turn it into reliable commands (one per identity it writes), queue
// them, show the result of replaying the queue on the canonical state, and ask for a sync. Each
// command is guarded by the revision it was made against (predicted from the canonical workspace
// plus the commands already queued), so a change made elsewhere meanwhile surfaces as a conflict
// instead of being overwritten, and carries its own command ID so a lost response can be replayed.
// The flush owns sending, ordering, retries and retaining refusals; actions never touch the network.
async function commit(intents: Intent[], config: ApiConfig, dispatch: Dispatch<AppAction>): Promise<void> {
  if (intents.length > 0) {
    const workspace = (await currentWorkspace(config.apiBase)) ?? { entities: new Map() };
    for (const intent of intents) {
      const base = intent.kind === 'task.create' ? null : predictBase(workspace, await idbGetPendingOps(), intentWrites(intent)[0]!);
      await idbQueueOp({ op: 'command', commandId: genId('c'), intent, base });
    }
  }
  const view = await loadView(config.apiBase);
  dispatch({ type: 'SET_DATA', tasks: view.tasks, projects: view.projects, links: view.links });
  if (intents.length > 0) requestSync();
}

async function findTask(id: string, config: ApiConfig): Promise<Task | undefined> {
  return (await loadView(config.apiBase)).tasks.find(t => t.id === id);
}

// Run a pure mutation against the current task, then queue the commands for what it changed. A
// refused mutation (for example focusing a completed task) is reported and queues nothing.
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
  await commit(intentsFromPatch(task, mutation.value.body as TaskUpdatePatch & { status?: string }), config, dispatch);
  return true;
}

export async function createTaskAction(
  title: NonEmptyString<200>,
  config: ApiConfig,
  dispatch: Dispatch<AppAction>,
): Promise<void> {
  await commit([{ kind: 'task.create', id: genId('t'), title, notes: null, kickoffNote: null, taskType: 'action' }], config, dispatch);
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
  if (!(await findTask(id, config))) return;
  if (subtasksOf((await loadView(config.apiBase)).tasks, id).length > 0) {
    dispatch({ type: 'SET_TOAST', message: 'This task has subtasks; delete or detach them first.' });
    return;
  }
  await commit([{ kind: 'task.delete', id }], config, dispatch);
}

export async function completeTaskAction(
  id: string,
  config: ApiConfig,
  dispatch: Dispatch<AppAction>,
): Promise<string | null> {
  const task = await findTask(id, config);
  if (!task) return null;
  if (subtasksOf((await loadView(config.apiBase)).tasks, id).some(child => child.status === 'pending')) {
    dispatch({ type: 'SET_TOAST', message: 'Complete the open subtasks first.' });
    return null;
  }
  const mutation = applyComplete(task, nowIso());
  if (!mutation.ok) {
    dispatch({ type: 'SET_TOAST', message: mutation.error.message });
    return null;
  }
  await commit([{ kind: 'task.complete', id, successorId: task.recurrence !== null ? genId('t') : null }], config, dispatch);
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
  const [from, to] = linkType === 'related' && fromId > toId ? [toId, fromId] : [fromId, toId];
  await commit([{ kind: 'link.add', from, to, linkType }], config, dispatch);
}

export async function deleteLinkAction(
  fromId: string,
  toId: string,
  linkType: TaskLink['link_type'],
  config: ApiConfig,
  dispatch: Dispatch<AppAction>,
): Promise<void> {
  // A related link may be stored in either endpoint order; remove whichever identity exists.
  const view = await loadView(config.apiBase);
  const stored = view.links.find(l => l.link_type === linkType && ((l.from_task_id === fromId && l.to_task_id === toId) || (linkType === 'related' && l.from_task_id === toId && l.to_task_id === fromId)));
  if (!stored) return;
  await commit([{ kind: 'link.remove', from: stored.from_task_id, to: stored.to_task_id, linkType }], config, dispatch);
}
