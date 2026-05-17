import type {
  BoundedString,
  DoneTaskStatus,
  DeferKind,
  IsoDate,
  IsoDateTime,
  NonEmptyString,
  PendingTaskStatus,
  ProjectId,
  Rrule,
  RruleParts,
  TaskId,
  TaskStatus,
  TaskType,
  ValidationError,
} from '../parse';
import {
  parseBounded,
  parseDeferKind,
  parseIsoDate,
  parseIsoDateTime,
  parseNonEmpty,
  parseProjectId,
  parseRrule,
  parseTaskId,
  parseTaskStatus,
  parseTaskType,
} from '../parse';
import { err, ok, type Result } from '@shared/result';
import type { Task } from '@shared/types';
import type { AppError } from './errors';
import { validationErrorResult } from './errors';

export type DeferState =
  | { kind: 'none' }
  | { kind: 'someday' }
  | { kind: 'until'; until: IsoDateTime };

export type Focus =
  | { kind: 'unfocused' }
  | { kind: 'focused'; until: IsoDateTime };

export type Recurrence =
  | { kind: 'one_shot' }
  | { kind: 'recurring'; rrule: Rrule; parts: RruleParts; firstDue: IsoDate };

export interface TaskBase {
  id: TaskId;
  title: NonEmptyString<200>;
  notes: BoundedString<10_000> | null;
  taskType: TaskType;
  projectId: ProjectId | null;
  dueDate: IsoDate | null;
  recurrence: Recurrence;
  kickoffNote: BoundedString<2_000> | null;
  sessionLog: BoundedString<10_000> | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export type PendingTaskDomain = TaskBase & {
  lifecycle: 'pending';
  status: PendingTaskStatus;
  defer: DeferState;
  focus: Focus;
};

export type DeferredPendingTaskDomain = PendingTaskDomain & {
  defer: Exclude<DeferState, { kind: 'none' }>;
};

export type NonDeferredPendingTaskDomain = PendingTaskDomain & {
  defer: { kind: 'none' };
};

export type DoneTaskDomain = TaskBase & {
  lifecycle: 'done';
  status: DoneTaskStatus;
  defer: { kind: 'none' };
  focus: { kind: 'unfocused' };
};

export type TaskDomain = PendingTaskDomain | DoneTaskDomain;

function withPath(path: string, errors: ValidationError[]): ValidationError[] {
  return errors.map(error => ({
    ...error,
    path: [path, ...error.path],
  }));
}

function nullableBounded<const Max extends number>(
  path: string,
  max: Max,
  input: string | null,
): Result<BoundedString<Max> | null, ValidationError[]> {
  if (input === null) return ok(null);
  const parsed = parseBounded(max, input);
  return parsed.ok ? ok(parsed.value) : err(withPath(path, parsed.error));
}

function nullableIsoDate(path: string, input: string | null): Result<IsoDate | null, ValidationError[]> {
  if (input === null) return ok(null);
  const parsed = parseIsoDate(input);
  return parsed.ok ? ok(parsed.value) : err(withPath(path, parsed.error));
}

function nullableIsoDateTime(path: string, input: string | null): Result<IsoDateTime | null, ValidationError[]> {
  if (input === null) return ok(null);
  const parsed = parseIsoDateTime(input);
  return parsed.ok ? ok(parsed.value) : err(withPath(path, parsed.error));
}

function nullableProjectId(path: string, input: string | null): Result<ProjectId | null, ValidationError[]> {
  if (input === null) return ok(null);
  const parsed = parseProjectId(input);
  return parsed.ok ? ok(parsed.value) : err(withPath(path, parsed.error));
}

function deferStateFromRow(kind: DeferKind, until: IsoDateTime | null): Result<DeferState, ValidationError[]> {
  switch (kind as string) {
    case 'none':
      if (until !== null) {
        return err([{
          path: ['defer_until'],
          code: 'invalid_state',
          message: 'defer_until must be null when defer_kind is none.',
        }]);
      }
      return ok({ kind: 'none' });
    case 'someday':
      if (until !== null) {
        return err([{
          path: ['defer_until'],
          code: 'invalid_state',
          message: 'defer_until must be null when defer_kind is someday.',
        }]);
      }
      return ok({ kind: 'someday' });
    case 'until':
      return until
        ? ok({ kind: 'until', until })
        : err([{ path: ['defer_until'], code: 'required', message: 'defer_until is required when defer_kind is until.' }]);
    default:
      return err([{ path: ['defer_kind'], code: 'picklist', message: 'Expected defer_kind to be none, until, or someday.' }]);
  }
}

function focusFromRow(until: IsoDateTime | null): Focus {
  return until ? { kind: 'focused', until } : { kind: 'unfocused' };
}

export function recurrenceFromRow(
  dueDateInput: string | null,
  recurrenceInput: string | null,
): Result<Recurrence, ValidationError[]> {
  const errors: ValidationError[] = [];
  const dueDate = nullableIsoDate('due_date', dueDateInput);
  if (!dueDate.ok) errors.push(...dueDate.error);

  if (recurrenceInput === null) {
    return errors.length > 0 ? err(errors) : ok({ kind: 'one_shot' });
  }

  const parsedRule = parseRrule(recurrenceInput);
  if (!parsedRule.ok) errors.push(...withPath('recurrence', parsedRule.error));

  if (dueDate.ok && dueDate.value === null) {
    errors.push({
      path: ['due_date'],
      code: 'required',
      message: 'due_date is required when recurrence is set.',
    });
  }

  if (!parsedRule.ok || !dueDate.ok || dueDate.value === null || errors.length > 0) return err(errors);

  return ok({
    kind: 'recurring',
    rrule: parsedRule.value.rrule,
    parts: parsedRule.value.parts,
    firstDue: dueDate.value,
  });
}

export function taskFromRow(row: Task): Result<TaskDomain, ValidationError[]> {
  const errors: ValidationError[] = [];

  const id = parseTaskId(row.id);
  if (!id.ok) errors.push(...withPath('id', id.error));

  const title = parseNonEmpty(200, row.title);
  if (!title.ok) errors.push(...withPath('title', title.error));

  const notes = nullableBounded('notes', 10_000, row.notes);
  if (!notes.ok) errors.push(...notes.error);

  const status = parseTaskStatus(row.status);
  if (!status.ok) errors.push(...withPath('status', status.error));

  const taskType = parseTaskType(row.task_type);
  if (!taskType.ok) errors.push(...withPath('task_type', taskType.error));

  const projectId = nullableProjectId('project_id', row.project_id);
  if (!projectId.ok) errors.push(...projectId.error);

  const dueDate = nullableIsoDate('due_date', row.due_date);
  if (!dueDate.ok) errors.push(...dueDate.error);

  const recurrence = recurrenceFromRow(row.due_date, row.recurrence);
  if (!recurrence.ok) errors.push(...recurrence.error);

  const kickoffNote = nullableBounded('kickoff_note', 2_000, row.kickoff_note);
  if (!kickoffNote.ok) errors.push(...kickoffNote.error);

  const sessionLog = nullableBounded('session_log', 10_000, row.session_log);
  if (!sessionLog.ok) errors.push(...sessionLog.error);

  const createdAt = parseIsoDateTime(row.created_at);
  if (!createdAt.ok) errors.push(...withPath('created_at', createdAt.error));

  const updatedAt = parseIsoDateTime(row.updated_at);
  if (!updatedAt.ok) errors.push(...withPath('updated_at', updatedAt.error));

  const deferUntil = nullableIsoDateTime('defer_until', row.defer_until);
  if (!deferUntil.ok) errors.push(...deferUntil.error);

  const deferKind = parseDeferKind(row.defer_kind);
  if (!deferKind.ok) errors.push(...withPath('defer_kind', deferKind.error));

  const focusedUntil = nullableIsoDateTime('focused_until', row.focused_until);
  if (!focusedUntil.ok) errors.push(...focusedUntil.error);

  const defer = deferKind.ok && deferUntil.ok
    ? deferStateFromRow(deferKind.value, deferUntil.value)
    : null;
  if (defer && !defer.ok) errors.push(...defer.error);

  const focus = focusedUntil.ok ? focusFromRow(focusedUntil.value) : null;

  if (status.ok && defer?.ok && focus) {
    const parsedStatus = status.value as TaskStatus;
    if ((parsedStatus as string) === 'done') {
      if (defer.value.kind !== 'none') {
        errors.push({
          path: ['defer_kind'],
          code: 'invalid_state',
          message: 'Done tasks cannot be deferred.',
        });
      }
      if (focus.kind !== 'unfocused') {
        errors.push({
          path: ['focused_until'],
          code: 'invalid_state',
          message: 'Done tasks cannot be focused.',
        });
      }
    } else if (defer.value.kind !== 'none' && focus.kind === 'focused') {
      errors.push({
        path: ['focused_until'],
        code: 'invalid_state',
        message: 'focused_until must be null when a task is deferred.',
      });
    }
  }

  if (
    !id.ok ||
    !title.ok ||
    !notes.ok ||
    !status.ok ||
    !taskType.ok ||
    !projectId.ok ||
    !dueDate.ok ||
    !recurrence.ok ||
    !kickoffNote.ok ||
    !sessionLog.ok ||
    !createdAt.ok ||
    !updatedAt.ok ||
    !deferUntil.ok ||
    !deferKind.ok ||
    !focusedUntil.ok ||
    !defer ||
    !defer.ok ||
    !focus ||
    errors.length > 0
  ) {
    return err(errors);
  }

  const base: TaskBase = {
    id: id.value,
    title: title.value,
    notes: notes.value,
    taskType: taskType.value,
    projectId: projectId.value,
    dueDate: dueDate.value,
    recurrence: recurrence.value,
    kickoffNote: kickoffNote.value,
    sessionLog: sessionLog.value,
    createdAt: createdAt.value,
    updatedAt: updatedAt.value,
  };

  const parsedStatus = status.value as TaskStatus;
  if ((parsedStatus as string) === 'done') {
    return ok({
      ...base,
      lifecycle: 'done',
      status: parsedStatus as DoneTaskStatus,
      defer: { kind: 'none' },
      focus: { kind: 'unfocused' },
    });
  }

  return ok({
    ...base,
    lifecycle: 'pending',
    status: parsedStatus as PendingTaskStatus,
    defer: defer.value,
    focus,
  });
}

export function pendingTaskFromRow(row: Task): Result<PendingTaskDomain, AppError> {
  const parsed = taskFromRow(row);
  if (!parsed.ok) return err(validationErrorResult(parsed.error));
  if (parsed.value.lifecycle !== 'pending') {
    return err({ kind: 'invalid_transition', message: 'Only pending tasks can use this transition.' });
  }
  return ok(parsed.value);
}
