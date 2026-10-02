import * as v from 'valibot';
import { RevisionSchema, parseSchema } from '../parse';

export const SyncCursorSchema = v.strictObject({ epoch: RevisionSchema, sequence: RevisionSchema });
export type SyncCursor = v.InferOutput<typeof SyncCursorSchema>;
export const parseSyncCursor = (input: unknown) => parseSchema(SyncCursorSchema, input);
export const SyncResetSchema = v.pipe(v.strictObject({
  reason: v.picklist(['epoch_changed', 'history_expired', 'cursor_ahead', 'watermark_ahead']),
  currentCursor: SyncCursorSchema, retentionFloor: RevisionSchema,
}), v.check(value => value.retentionFloor <= value.currentCursor.sequence, 'Retention floor cannot exceed the current sequence.'));
