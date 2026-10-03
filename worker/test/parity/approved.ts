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
  'update_project.status-unchanged': 'Finding 2 (approved): setting a project to the status it already has compiles to no command, so updated_at no longer moves. It still logs and returns the project.',
  'update_project.archive-already-archived': 'Finding 2 (approved): archiving an archived project compiles to no command, so updated_at no longer moves. It still logs and returns the project.',
  'link_tasks.existing-related-reversed': 'Finding 3 (approved): a related link that already exists in the other orientation is the existing link, so no second row is stored. It still logs and answers linked.',
  'link_tasks.related': 'Approved 2026-10-03: related links are symmetric and the command requires ascending endpoints, so the row is stored from the lower ID to the higher regardless of argument order. The response still echoes the arguments as given.',
  'create_project.thirty-tasks': 'Finding 5 (approved): the command bound is now the 100-statement atomic limit, not 20 commands. Each assigned task costs more statements than before (its update, guard, diff, audit and feed rows), so the ceiling is 23 tasks where the legacy path reached 33. A larger call is refused with capacity_exceeded and nothing is written.',
  'update_task.all-day-only-no-due': 'Approved 2026-10-03: legacy stored an all-day flag on a task with no due date, a state the commands cannot represent (clearing the due date requires a null classification). The adapter refuses.',
};

const file = fileURLToPath(new URL('./approved-outcomes.json', import.meta.url));
const outcomes: Record<string, Outcome> = (() => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } })();

export const APPROVED_DIFFERENCES: Record<string, { reason: string; outcome: Outcome }> = Object.fromEntries(
  Object.entries(APPROVAL_REASONS).map(([id, reason]) => [id, { reason, outcome: outcomes[id] as Outcome }]),
);
export const APPROVED_OUTCOMES_FILE = file;
