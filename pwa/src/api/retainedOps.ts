import * as v from 'valibot';
import type { Result } from '@shared/result';
import { parseSchema, type ValidationError } from '@shared/parse';
import { parsePendingOp, type PendingOp } from './pendingOps';

/**
 * A queued command the server durably refused (or that can no longer succeed because an
 * earlier command it depends on was refused). The user's intent is kept, with diagnostics,
 * instead of being dropped; it never flushes again and is not overlaid on canonical state.
 */
export type RetainedReason =
  | { kind: 'rejected'; status: number; message: string }
  | { kind: 'dependency'; dependsOn: string; message: string };

export type RetainedOp = { id?: number; retained_at: string; reason: RetainedReason; op: PendingOp };

const ReasonSchema = v.variant('kind', [
  v.object({ kind: v.literal('rejected'), status: v.number(), message: v.string() }),
  v.object({ kind: v.literal('dependency'), dependsOn: v.string(), message: v.string() }),
]);
const EnvelopeSchema = v.object({ id: v.optional(v.number()), retained_at: v.string(), reason: ReasonSchema, op: v.unknown() });

export function parseRetainedOp(input: unknown): Result<RetainedOp, ValidationError[]> {
  const envelope = parseSchema(EnvelopeSchema, input);
  if (!envelope.ok) return envelope;
  const op = parsePendingOp(envelope.value.op);
  if (!op.ok) return op;
  const { id, retained_at, reason } = envelope.value;
  return { ok: true, value: { ...(id === undefined ? {} : { id }), retained_at, reason, op: op.value } };
}
