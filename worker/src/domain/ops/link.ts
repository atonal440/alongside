import type { Result } from '@shared/result';
import type { AppError } from '../errors';
import type { Plan } from '../Op';
import type { TaskLinkDomain } from '../link';

export type LinkPlanResult = Result<Plan, AppError>;

export interface LinkPlanner {
  linkTasksPlan(link: TaskLinkDomain): LinkPlanResult;
}
