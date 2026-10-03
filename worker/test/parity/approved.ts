import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Outcome } from './harness';

/**
 * Rows where an adapter is allowed to differ from the legacy handler, with the reason. The
 * adapter's outcome is pinned in approved-outcomes.json (re-record with PARITY_APPROVE=1) so a
 * further drift fails the row. Add a row here only after the difference is approved.
 */
export const APPROVAL_REASONS: Record<string, string> = {
  'update_task.status-pending-on-pending': 'Finding 2 (approved): a call whose patch compiles to no command writes no row, so updated_at no longer moves. It still logs and returns the task.',
  'update_task.status-pending-on-deferred': 'Finding 2 (approved): status pending on a pending task compiles to nothing, so updated_at no longer moves and the deferral is still not cleared.',
  'update_task.focus-clear-on-done': 'Finding 2 (approved): clearing focus on a done task is a no-op because completion already cleared it, so updated_at no longer moves.',
  'update_task.all-day-only-no-due': 'PROPOSED, NOT YET APPROVED: legacy stored an all-day flag on a task with no due date, a state the commands cannot represent (clearing the due date requires a null classification). The adapter refuses.',
};

const file = fileURLToPath(new URL('./approved-outcomes.json', import.meta.url));
const outcomes: Record<string, Outcome> = (() => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } })();

export const APPROVED_DIFFERENCES: Record<string, { reason: string; outcome: Outcome }> = Object.fromEntries(
  Object.entries(APPROVAL_REASONS).map(([id, reason]) => [id, { reason, outcome: outcomes[id] as Outcome }]),
);
export const APPROVED_OUTCOMES_FILE = file;
