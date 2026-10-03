/**
 * Stored command receipts.
 *
 * Version 1 (no `receiptVersion`) is a bare `ChangesResult`, as `apply_changes` has always stored.
 * Version 2 wraps the result with the complete response of the quick-verb or deprecated tool that
 * produced it, so a retried call replays exactly what the first call returned instead of re-reading
 * current state. `result` is null only for a no-op: the call changed no entity, but its command ID
 * is still recorded so a retry cannot do something new. See docs/plans/mcp-surface.md.
 */
import * as v from 'valibot';
import { parseSchema, type ValidationError } from '../parse';
import type { Result } from '../result';
import { ChangesResultSchema, type ChangesResult } from './commands';
import { ProjectRowSchema, TaskRowSchema, projectRowEntries, taskRowEntries } from './rows';

/** Tools whose adapters write receipts, in the order of the parity matrix. */
export const RECEIPT_TOOLS = [
  'add_task', 'complete_task', 'defer_task', 'update_task', 'reopen_task', 'focus_task', 'delete_task',
  'create_project', 'update_project', 'delete_project', 'link_tasks', 'unlink_tasks', 'update_preference',
] as const;
export type ReceiptTool = (typeof RECEIPT_TOOLS)[number];

/** The projection of an `action_log` row that tools return to the widget. */
export const ActionLogEntrySchema = v.strictObject({
  tool_name: v.string(), title: v.string(), detail: v.nullable(v.string()),
});
const entry = { action_log_entry: ActionLogEntrySchema };
const taskWithEntry = v.strictObject({ ...taskRowEntries, ...entry });
const projectWithEntry = v.strictObject({ ...projectRowEntries, ...entry });

/** Response codec per tool: exactly what the legacy handler returns today (see the parity matrix). */
export const TOOL_RESPONSE_SCHEMAS = {
  add_task: taskWithEntry,
  defer_task: taskWithEntry,
  update_task: taskWithEntry,
  reopen_task: taskWithEntry,
  focus_task: taskWithEntry,
  complete_task: v.strictObject({ completed: TaskRowSchema, next: v.optional(TaskRowSchema), ...entry }),
  delete_task: v.strictObject({ deleted: v.literal(true), task_id: v.string(), title: v.string(), ...entry }),
  create_project: v.strictObject({ project: ProjectRowSchema, linked_task_count: v.pipe(v.number(), v.integer(), v.minValue(0)), ...entry }),
  update_project: projectWithEntry,
  delete_project: v.strictObject({ deleted: v.literal(true), project_id: v.string(), title: v.string(), ...entry }),
  link_tasks: v.strictObject({
    linked: v.literal(true), from_task_id: v.string(), from_task_title: v.optional(v.string()),
    to_task_id: v.string(), to_task_title: v.optional(v.string()), link_type: v.picklist(['blocks', 'related']), ...entry,
  }),
  unlink_tasks: v.strictObject({ unlinked: v.literal(true), from_task_id: v.string(), to_task_id: v.string(), ...entry }),
  // update_preference never logs, so its response carries no action_log_entry.
  update_preference: v.strictObject({ updated: v.literal(true), key: v.string(), value: v.string() }),
} as const satisfies Record<ReceiptTool, v.GenericSchema>;

export const ReceiptV2Schema = v.pipe(
  v.strictObject({
    receiptVersion: v.literal(2),
    tool: v.picklist(RECEIPT_TOOLS),
    result: v.nullable(ChangesResultSchema),
    response: v.unknown(),
  }),
  v.check(receipt => v.safeParse(TOOL_RESPONSE_SCHEMAS[receipt.tool], receipt.response).success, 'The stored response does not match its tool.'),
);
export type ReceiptV2 = v.InferOutput<typeof ReceiptV2Schema>;

export type StoredResult =
  | { receiptVersion: 1; result: ChangesResult }
  | { receiptVersion: 2; tool: ReceiptTool; result: ChangesResult | null; response: unknown };

/** Parse a `command_receipts.result_json` document. A document without `receiptVersion` is version 1. */
export function parseStoredResult(json: string): Result<StoredResult, ValidationError[]> {
  let value: unknown;
  try { value = JSON.parse(json); } catch { return { ok: false, error: [{ path: [], code: 'invalid_json', message: 'Stored receipt is not JSON.' }] }; }
  const versioned = value !== null && typeof value === 'object' && 'receiptVersion' in value;
  if (!versioned) {
    const parsed = parseSchema(ChangesResultSchema, value);
    return parsed.ok ? { ok: true, value: { receiptVersion: 1, result: parsed.value } } : parsed;
  }
  const parsed = parseSchema(ReceiptV2Schema, value);
  if (!parsed.ok) return parsed;
  const { tool, result } = parsed.value;
  return { ok: true, value: { receiptVersion: 2, tool, result, response: (value as { response: unknown }).response } };
}
