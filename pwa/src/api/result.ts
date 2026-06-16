import type { ValidationError } from '@shared/parse';

export type ApiErrorBody = { error: string; details?: ValidationError[] };

export type ApiResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'http'; status: number; body: ApiErrorBody }
  | { kind: 'contract'; status: number; issues: ValidationError[]; raw: unknown }
  | { kind: 'network' }
  | { kind: 'unconfigured' };

// 4xx HTTP responses and contract violations are durable: retrying cannot succeed.
export function isDurableFailure(r: ApiResult<unknown>): boolean {
  if (r.kind === 'http') return r.status >= 400 && r.status < 500;
  return r.kind === 'contract';
}

// Network errors and 5xx HTTP responses are transient: may succeed on retry.
export function isTransientFailure(r: ApiResult<unknown>): boolean {
  if (r.kind === 'network') return true;
  if (r.kind === 'http') return r.status >= 500;
  return false;
}
