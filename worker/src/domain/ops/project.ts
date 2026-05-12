import type { Result } from '@shared/result';
import type { AppError } from '../errors';
import type { Plan } from '../Op';
import type { ProjectDomain } from '../project';

export type ProjectPlanResult = Result<Plan, AppError>;

export interface ProjectPlanner {
  createProjectPlan(project: ProjectDomain): ProjectPlanResult;
}
