import type { Result } from '@shared/result';
import type { AppError } from '../errors';
import type { Plan } from '../Op';
import type { PendingTaskDomain } from '../task';

export type TaskPlanResult = Result<Plan, AppError>;

export interface CompleteTaskPlanner {
  completeTaskPlan(task: PendingTaskDomain): TaskPlanResult;
}
