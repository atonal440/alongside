import type { Result } from '@shared/result';
import { err, ok } from '@shared/result';
import { nextOccurrence, type IsoDateTime, type MintedTaskId } from '../../parse';
import type { AppError } from '../errors';
import type { Plan } from '../Op';
import type { TaskRow } from '../Op';
import type { PendingTaskDomain } from '../task';

export type TaskPlanResult = Result<Plan, AppError>;

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

export interface CompleteTaskPlanner {
  completeTaskPlan(task: PendingTaskDomain, input: CompleteTaskPlanInput): TaskPlanResult;
}
