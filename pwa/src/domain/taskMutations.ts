import type { Task } from '@shared/types';
import type { IsoDateTime, NonEmptyString } from '@shared/parse';
import { ok, err, type Result } from '@shared/result';
import type { TaskUpdateBody } from '../api/endpoints';

export type LocalMutationError = { code: string; message: string };

export interface TaskWrite {
  task: Task;
  body: TaskUpdateBody;
}

// Discriminated defer input — makes { kind: 'someday', until: ... } unrepresentable.
export type DeferInput =
  | { kind: 'someday' }
  | { kind: 'until'; until: IsoDateTime };

// Content-field update patch. Excludes status (use applyComplete/applyReopen).
// Defer fields included so EditView's unified save still works through updateTaskAction;
// dedicated applyDefer/applyClearDefer enforce atomicity for the action buttons.
// Stage 7 will tighten field types to branded NonEmptyString/IsoDate etc.
export interface TaskUpdatePatch {
  title?: string;
  notes?: string | null;
  due_date?: string | null;
  recurrence?: string | null;
  task_type?: string;
  project_id?: string | null;
  kickoff_note?: string | null;
  session_log?: string | null;
  defer_kind?: string;
  defer_until?: string | null;
  focused_until?: string | null;
}

// Max focus window, mirrors worker/src/mcp.ts MAX_FOCUS_HOURS.
const MAX_FOCUS_HOURS = 24;

export function newLocalTask(
  title: NonEmptyString<200>,
  nowIso: IsoDateTime,
  id: string,
): Task {
  return {
    id,
    title,
    notes: null,
    status: 'pending',
    due_date: null,
    recurrence: null,
    created_at: nowIso,
    updated_at: nowIso,
    defer_until: null,
    defer_kind: 'none',
    task_type: 'action',
    project_id: null,
    kickoff_note: null,
    session_log: null,
    focused_until: null,
  };
}

// General-purpose content update. Enforces recurrence ↔ due-date invariant.
export function applyUpdate(
  task: Task,
  patch: TaskUpdatePatch,
  nowIso: IsoDateTime,
): Result<TaskWrite, LocalMutationError> {
  const effectiveDueDate = 'due_date' in patch ? patch.due_date : task.due_date;
  const effectiveRecurrence = 'recurrence' in patch ? patch.recurrence : task.recurrence;
  if (effectiveRecurrence !== null && effectiveRecurrence !== undefined && effectiveDueDate === null) {
    return err({ code: 'recurrence_requires_due_date', message: 'Recurrence requires a due date.' });
  }

  const updated: Task = { ...task, ...patch, updated_at: nowIso } as Task;
  const body: TaskUpdateBody = { ...patch };
  return ok({ task: updated, body });
}

// Marks task done. Does NOT mint the next recurring occurrence — that is the server's job.
export function applyComplete(
  task: Task,
  nowIso: IsoDateTime,
): Result<TaskWrite & { wasRecurring: boolean }, LocalMutationError> {
  if (task.status === 'done') {
    return err({ code: 'already_done', message: 'Task is already complete.' });
  }
  const wasRecurring = task.recurrence !== null;
  const updated: Task = { ...task, status: 'done', updated_at: nowIso };
  // complete endpoint takes no body; body field is unused by the action creator.
  const body: TaskUpdateBody = {};
  return ok({ task: updated, body, wasRecurring });
}

// Atomic defer: kind='until' sets both fields; 'someday' nulls defer_until.
// Always clears focused_until — deferring and focusing are mutually exclusive.
export function applyDefer(
  task: Task,
  defer: DeferInput,
  nowIso: IsoDateTime,
): Result<TaskWrite, LocalMutationError> {
  if (task.status === 'done') {
    return err({ code: 'not_pending', message: 'Cannot defer a completed task.' });
  }
  const defer_kind = defer.kind;
  const defer_until = defer.kind === 'until' ? defer.until : null;
  const updated: Task = { ...task, defer_kind, defer_until, focused_until: null, updated_at: nowIso };
  const body: TaskUpdateBody = { defer_kind, defer_until, focused_until: null };
  return ok({ task: updated, body });
}

export function applyClearDefer(
  task: Task,
  nowIso: IsoDateTime,
): Result<TaskWrite, LocalMutationError> {
  if (task.status === 'done') {
    return err({ code: 'not_pending', message: 'Cannot clear defer on a completed task.' });
  }
  const updated: Task = { ...task, defer_kind: 'none', defer_until: null, updated_at: nowIso };
  const body: TaskUpdateBody = { defer_kind: 'none', defer_until: null };
  return ok({ task: updated, body });
}

// Focus hours must be finite, positive, and ≤ MAX_FOCUS_HOURS (mirrors worker).
export function applyFocus(
  task: Task,
  hours: number,
  nowIso: IsoDateTime,
): Result<TaskWrite, LocalMutationError> {
  if (task.status === 'done') {
    return err({ code: 'not_pending', message: 'Cannot focus a completed task.' });
  }
  if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_FOCUS_HOURS) {
    return err({
      code: 'invalid_hours',
      message: `Focus hours must be greater than 0 and no more than ${MAX_FOCUS_HOURS}.`,
    });
  }
  const focused_until = new Date(Date.parse(nowIso) + hours * 3_600_000).toISOString();
  // Mirror worker's focusTaskPlan: focusing a deferred task clears the defer.
  const clearDefer = task.defer_kind !== 'none';
  const updated: Task = {
    ...task,
    focused_until,
    ...(clearDefer ? { defer_kind: 'none', defer_until: null } : {}),
    updated_at: nowIso,
  };
  const body: TaskUpdateBody = {
    focused_until,
    ...(clearDefer ? { defer_kind: 'none', defer_until: null } : {}),
  };
  return ok({ task: updated, body });
}

export function applyUnfocus(
  task: Task,
  nowIso: IsoDateTime,
): Result<TaskWrite, LocalMutationError> {
  const updated: Task = { ...task, focused_until: null, updated_at: nowIso };
  const body: TaskUpdateBody = { focused_until: null };
  return ok({ task: updated, body });
}

// Mirrors worker's reopenTaskPlan: accepts done tasks and deferred pending tasks.
// Always produces status='pending', defer_kind='none', defer_until=null, focused_until=null.
export function applyReopen(
  task: Task,
  nowIso: IsoDateTime,
): Result<TaskWrite, LocalMutationError> {
  const isDone = task.status === 'done';
  const isDeferred = task.defer_kind !== 'none';
  if (!isDone && !isDeferred) {
    return err({ code: 'not_reopenable', message: 'Only completed or deferred tasks can be reopened.' });
  }
  const updated: Task = {
    ...task,
    status: 'pending',
    defer_kind: 'none',
    defer_until: null,
    focused_until: null,
    updated_at: nowIso,
  };
  const body: TaskUpdateBody = {
    status: 'pending',
    defer_kind: 'none',
    defer_until: null,
    focused_until: null,
  };
  return ok({ task: updated, body });
}
