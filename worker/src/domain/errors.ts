import type { ValidationError } from '@shared/parse';

export type AppError =
  | { kind: 'validation'; errors: ValidationError[] }
  | { kind: 'not_found'; entity: 'task' | 'project' | 'link' | 'preference' | 'oauth_code'; id?: string }
  | { kind: 'conflict'; message: string }
  | { kind: 'invalid_transition'; message: string }
  | { kind: 'invariant_violation'; message: string }
  | { kind: 'storage'; message: string; cause?: unknown };

export function validationErrorResult(errors: ValidationError[]): AppError {
  return { kind: 'validation', errors };
}

export function appErrorStatus(error: AppError): number {
  switch (error.kind) {
    case 'validation':
      return 400;
    case 'not_found':
      return 404;
    case 'conflict':
    case 'invalid_transition':
    case 'invariant_violation':
      return 409;
    case 'storage':
      return 500;
  }
}

export function appErrorMessage(error: AppError): string {
  switch (error.kind) {
    case 'validation':
      return error.errors.map(issue => issue.message).join('; ');
    case 'not_found':
      return error.id ? `${error.entity} not found: ${error.id}` : `${error.entity} not found`;
    case 'conflict':
    case 'invalid_transition':
    case 'invariant_violation':
    case 'storage':
      return error.message;
  }
}
