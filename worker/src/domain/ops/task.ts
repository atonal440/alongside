import type { Result } from '@shared/result';
import { err, ok } from '@shared/result';
import { nextOccurrence, type IsoDateTime, type MintedTaskId } from '../../parse';
import type { AppError } from '../errors';
import type { Plan } from '../Op';
import type { TaskRow } from '../Op';
import type {
  DeferState,
  DeferredPendingTaskDomain,
  DoneTaskDomain,
  Focus,
  PendingTaskDomain,
  TaskDomain,
} from '../task';

export type TaskPlanResult = Result<Plan, AppError>;
export type ActiveDeferState = Exclude<DeferState, { kind: 'none' }>;
export type FocusedState = Extract<Focus, { kind: 'focused' }>;
export type ReopenableTaskDomain = DoneTaskDomain | DeferredPendingTaskDomain;

function singleUpdatePlan(task: PendingTaskDomain | DoneTaskDomain, patch: TaskRowUpdatePatch): Plan {
  return {
    ops: [{ kind: 'task.update', id: task.id, patch }],
    assertions: [{ kind: 'task.exists', id: task.id }],
  };
}

type TaskRowUpdatePatch = NonNullable<Extract<Plan['ops'][number], { kind: 'task.update' }>['patch']>;

export interface CompleteTaskPlanInput {
  completedAt: IsoDateTime;
  nextTaskId?: MintedTaskId;
}

export function completeTaskPlan(task: PendingTaskDomain, input: CompleteTaskPlanInput): TaskPlanResult {
  const ops: Plan['ops'] = [{
    kind: 'task.update',
    id: task.id,
    patch: {
      status: 'done',
      defer_kind: 'none',
      defer_until: null,
      focused_until: null,
      updated_at: input.completedAt,
    },
  }];

  if (task.recurrence.kind === 'recurring') {
    if (!input.nextTaskId) {
      return err({
        kind: 'invariant_violation',
        message: 'A recurring task completion requires a next task id.',
      });
    }

    const nextDue = nextOccurrence(task.recurrence.parts, task.recurrence.firstDue);
    const nextKickoff = task.sessionLog ?? task.kickoffNote;
    const next: TaskRow = {
      id: input.nextTaskId,
      title: task.title,
      notes: task.notes,
      status: 'pending',
      due_date: nextDue,
      recurrence: task.recurrence.rrule,
      created_at: input.completedAt,
      updated_at: input.completedAt,
      defer_until: null,
      defer_kind: 'none',
      task_type: task.taskType,
      project_id: task.projectId,
      kickoff_note: nextKickoff,
      session_log: null,
      focused_until: null,
    };

    ops.push({ kind: 'task.insert', row: next });
  }

  return ok({ ops, assertions: [{ kind: 'task.exists', id: task.id }] });
}

export interface DeferTaskPlanInput {
  defer: ActiveDeferState;
  updatedAt: IsoDateTime;
}

export function deferTaskPlan(task: PendingTaskDomain, input: DeferTaskPlanInput): TaskPlanResult {
  return ok(singleUpdatePlan(task, {
    defer_kind: input.defer.kind,
    defer_until: input.defer.kind === 'until' ? input.defer.until : null,
    focused_until: null,
    updated_at: input.updatedAt,
  }));
}

export interface ClearDeferTaskPlanInput {
  updatedAt: IsoDateTime;
}

export function clearDeferTaskPlan(
  task: PendingTaskDomain,
  input: ClearDeferTaskPlanInput,
): TaskPlanResult {
  return ok(singleUpdatePlan(task, {
    defer_kind: 'none',
    defer_until: null,
    updated_at: input.updatedAt,
  }));
}

export interface FocusTaskPlanInput {
  focus: FocusedState;
  updatedAt: IsoDateTime;
}

export function focusTaskPlan(task: PendingTaskDomain, input: FocusTaskPlanInput): TaskPlanResult {
  const patch: TaskRowUpdatePatch = {
    focused_until: input.focus.until,
    updated_at: input.updatedAt,
  };

  if (task.defer.kind !== 'none') {
    patch.defer_kind = 'none';
    patch.defer_until = null;
  }

  return ok(singleUpdatePlan(task, patch));
}

export interface ReopenTaskPlanInput {
  updatedAt: IsoDateTime;
}

export function isReopenableTask(task: TaskDomain): task is ReopenableTaskDomain {
  return task.lifecycle === 'done' || task.defer.kind !== 'none';
}

export function reopenTaskPlan(task: ReopenableTaskDomain, input: ReopenTaskPlanInput): TaskPlanResult {
  return ok(singleUpdatePlan(task, {
    status: 'pending',
    defer_kind: 'none',
    defer_until: null,
    focused_until: null,
    updated_at: input.updatedAt,
  }));
}

export interface CompleteTaskPlanner {
  completeTaskPlan(task: PendingTaskDomain, input: CompleteTaskPlanInput): TaskPlanResult;
}
