import type { ApiResult } from './result';
import type { PendingOp } from './pendingOps';

export type WriteOutcome =
  | { kind: 'applied' }
  | { kind: 'queued' }
  | { kind: 'rejected'; message: string };

// Flush stops retrying after this many transient failures on a single op.
// At the 30s cycle that's ~12 minutes before the "stuck" notice fires.
export const ATTEMPTS_CAP = 25;

// Extract a human-readable rejection message from a durable ApiResult.
export function messageFromResult(result: ApiResult<unknown>): string {
  if (result.kind === 'http') {
    const { error, details } = result.body;
    if (details && details.length > 0) return `${error}: ${details[0]?.message ?? ''}`;
    return error;
  }
  if (result.kind === 'contract') return 'App/server version mismatch — please reload.';
  return 'Unexpected error';
}

// Returns true if the op references taskId in any payload position.
export function referencesTaskId(op: PendingOp, taskId: string): boolean {
  switch (op.op) {
    case 'task.create':  return op.localId === taskId;
    case 'task.update':
    case 'task.complete':
    case 'task.delete':  return op.taskId === taskId;
    case 'link.create':
    case 'link.delete':
      return op.body.from_task_id === taskId || op.body.to_task_id === taskId;
  }
}
