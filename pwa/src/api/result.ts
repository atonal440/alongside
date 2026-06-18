import type { ValidationError } from '@shared/parse';

export type ApiErrorBody = { error: string; details?: ValidationError[] };

export type ApiResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'http'; status: number; body: ApiErrorBody }
  | { kind: 'contract'; status: number; issues: ValidationError[]; raw: unknown }
  | { kind: 'network' }
  | { kind: 'unconfigured' };

// 401/403/429 are recoverable: the user can fix credentials or wait out rate
// limiting. Treating them as durable would permanently drop queued ops (data
// loss) in cases where sync just needs credentials refreshed.
const TRANSIENT_4XX = new Set([401, 403, 429]);

// Semantic validation rejections (400/404/409/422) and contract violations are
// durable: retrying cannot succeed without user action to change the write.
export function isDurableFailure(r: ApiResult<unknown>): boolean {
  if (r.kind === 'http') return r.status >= 400 && r.status < 500 && !TRANSIENT_4XX.has(r.status);
  return r.kind === 'contract';
}

// Network errors, 5xx, and recoverable 4xx (auth, rate limit) are transient.
export function isTransientFailure(r: ApiResult<unknown>): boolean {
  if (r.kind === 'network') return true;
  if (r.kind === 'http') return r.status >= 500 || TRANSIENT_4XX.has(r.status);
  return false;
}
