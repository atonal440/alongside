import type { Result } from '@shared/result';
import type { AppError } from '../domain/errors';
import type { Plan } from '../domain/Op';

export interface ApplySummary {
  appliedOps: number;
}

export type ApplyResult = Result<ApplySummary, AppError>;

export interface PlanApplier {
  apply(plan: Plan): Promise<ApplyResult>;
}
