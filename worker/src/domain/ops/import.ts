import type { Result } from '@shared/result';
import type { AppError } from '../errors';
import type { Plan } from '../Op';

export type ImportPlanResult = Result<Plan, AppError>;

export interface ImportPlanner<Payload> {
  planImport(payload: Payload): ImportPlanResult;
}
