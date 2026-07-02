import * as v from 'valibot';
import type { Result } from '@shared/result';
import { parseSchema, type ValidationError } from '@shared/parse';
import type { ApiConfig } from './client';
import type { ApiResult } from './result';
import { api } from './endpoints';
import type { TaskCreateBody, TaskUpdateBody, LinkBody } from './endpoints';

export type PendingOpPayload =
  | { op: 'task.create'; localId: string; body: TaskCreateBody }
  | { op: 'task.update'; taskId: string; body: TaskUpdateBody }
  | { op: 'task.complete'; taskId: string }
  | { op: 'task.delete'; taskId: string }
  | { op: 'link.create'; body: LinkBody }
  | { op: 'link.delete'; body: LinkBody };

export type PendingOp = { id?: number; created_at: string; attempts: number } & PendingOpPayload;

export function toRequest(op: PendingOp, config: ApiConfig): Promise<ApiResult<unknown>> {
  switch (op.op) {
    case 'task.create':
      return api.createTask(op.body, config);
    case 'task.update':
      return api.updateTask(op.taskId, op.body, config);
    case 'task.complete':
      return api.completeTask(op.taskId, config);
    case 'task.delete':
      return api.deleteTask(op.taskId, config);
    case 'link.create':
      return api.createLink(op.body, config);
    case 'link.delete':
      return api.deleteLink(op.body, config);
  }
}

// Total rebind: rewrites every slot where oldId appears, returns op unchanged
// when oldId is absent. Uses strict equality — no substring matching.
export function rebindTaskId(op: PendingOp, oldId: string, newId: string): PendingOp {
  switch (op.op) {
    case 'task.create':
      return op.localId === oldId ? { ...op, localId: newId } : op;
    case 'task.update':
      return op.taskId === oldId ? { ...op, taskId: newId } : op;
    case 'task.complete':
      return op.taskId === oldId ? { ...op, taskId: newId } : op;
    case 'task.delete':
      return op.taskId === oldId ? { ...op, taskId: newId } : op;
    case 'link.create': {
      const { from_task_id, to_task_id } = op.body;
      if (from_task_id !== oldId && to_task_id !== oldId) return op;
      return {
        ...op,
        body: {
          ...op.body,
          from_task_id: from_task_id === oldId ? newId : from_task_id,
          to_task_id: to_task_id === oldId ? newId : to_task_id,
        },
      };
    }
    case 'link.delete': {
      const { from_task_id, to_task_id } = op.body;
      if (from_task_id !== oldId && to_task_id !== oldId) return op;
      return {
        ...op,
        body: {
          ...op.body,
          from_task_id: from_task_id === oldId ? newId : from_task_id,
          to_task_id: to_task_id === oldId ? newId : to_task_id,
        },
      };
    }
  }
}

const baseFields = {
  id: v.optional(v.number()),
  created_at: v.string(),
  attempts: v.number(),
};

const TaskCreateBodySchema = v.object({
  title: v.string(),
  notes: v.optional(v.nullable(v.string())),
  due_date: v.optional(v.nullable(v.string())),
  due_all_day: v.optional(v.boolean()),
  recurrence: v.optional(v.nullable(v.string())),
  task_type: v.optional(v.string()),
  project_id: v.optional(v.nullable(v.string())),
  kickoff_note: v.optional(v.nullable(v.string())),
});

const TaskUpdateBodySchema = v.object({
  title: v.optional(v.string()),
  notes: v.optional(v.nullable(v.string())),
  due_date: v.optional(v.nullable(v.string())),
  due_all_day: v.optional(v.boolean()),
  recurrence: v.optional(v.nullable(v.string())),
  task_type: v.optional(v.string()),
  project_id: v.optional(v.nullable(v.string())),
  kickoff_note: v.optional(v.nullable(v.string())),
  session_log: v.optional(v.nullable(v.string())),
  status: v.optional(v.string()),
  defer_until: v.optional(v.nullable(v.string())),
  defer_kind: v.optional(v.string()),
  focused_until: v.optional(v.nullable(v.string())),
});

const LinkBodySchema = v.object({
  from_task_id: v.string(),
  to_task_id: v.string(),
  link_type: v.string(),
});

const PendingOpSchema = v.variant('op', [
  v.object({ ...baseFields, op: v.literal('task.create'), localId: v.string(), body: TaskCreateBodySchema }),
  v.object({ ...baseFields, op: v.literal('task.update'), taskId: v.string(), body: TaskUpdateBodySchema }),
  v.object({ ...baseFields, op: v.literal('task.complete'), taskId: v.string() }),
  v.object({ ...baseFields, op: v.literal('task.delete'), taskId: v.string() }),
  v.object({ ...baseFields, op: v.literal('link.create'), body: LinkBodySchema }),
  v.object({ ...baseFields, op: v.literal('link.delete'), body: LinkBodySchema }),
]);

// Repair for ops queued before due_all_day existed (offline writes made by an
// older build, still sitting in IndexedDB when the app updates): such an op
// has due_date but no due_all_day key at all. The worker derives due_all_day
// from due_date's shape when it's omitted, which is wrong here — a queued
// op's due_date already went through this build's OWN normalization at
// submit time, not the fresh-input shape the derivation expects. Three
// generations of "no due_all_day key" can be sitting in the same queue:
//   1. Pre-Stage-1 builds: due_date is still a bare "YYYY-MM-DD" (Decision 4
//      hadn't landed) — unambiguously all-day, same as a fresh bare-date
//      submission today.
//   2. Stage-1-era builds (after due_date became a UTC instant, before
//      due_all_day): the date-only picker always produced the noon-UTC
//      anchor — all-day — but a build with the existingDueDate preservation
//      fix (before due_all_day itself) could resend an existing *timed*
//      due_date verbatim on an unrelated-field edit — not all-day.
// So: no "T" ⇒ bare date ⇒ all-day (case 1). Exactly noon UTC ⇒ the one
// instant every all-day source before this field could produce on purpose
// ⇒ all-day (case 2, ambiguous-but-default, same signal the server-side
// migration backfill uses on the same kind of already-collapsed data —
// worker/migrations/008_due_all_day.sql). Anything else was necessarily
// submitted with a real time.
function legacyIsAllDay(dueDate: string): boolean {
  return !dueDate.includes('T') || dueDate.endsWith('T12:00:00Z');
}

function needsDueAllDayRepair(body: TaskCreateBody | TaskUpdateBody): boolean {
  return !!body.due_date && !('due_all_day' in body);
}

function repairMissingDueAllDay(op: PendingOp): PendingOp {
  // Handled as two separate narrowed branches, not one combined condition —
  // spreading `op` after narrowing a compound `||` condition doesn't reliably
  // keep TS's discriminated-union structure (op/body would stop lining up).
  if (op.op === 'task.create' && needsDueAllDayRepair(op.body) && op.body.due_date) {
    return { ...op, body: { ...op.body, due_all_day: legacyIsAllDay(op.body.due_date) } };
  }
  if (op.op === 'task.update' && needsDueAllDayRepair(op.body) && op.body.due_date) {
    return { ...op, body: { ...op.body, due_all_day: legacyIsAllDay(op.body.due_date) } };
  }
  return op;
}

export function parsePendingOp(input: unknown): Result<PendingOp, ValidationError[]> {
  const parsed = parseSchema(PendingOpSchema, input) as Result<PendingOp, ValidationError[]>;
  return parsed.ok ? { ...parsed, value: repairMissingDueAllDay(parsed.value) } : parsed;
}
