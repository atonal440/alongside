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
  recurrence: v.optional(v.nullable(v.string())),
  task_type: v.optional(v.string()),
  project_id: v.optional(v.nullable(v.string())),
  kickoff_note: v.optional(v.nullable(v.string())),
});

const TaskUpdateBodySchema = v.object({
  title: v.optional(v.string()),
  notes: v.optional(v.nullable(v.string())),
  due_date: v.optional(v.nullable(v.string())),
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

export function parsePendingOp(input: unknown): Result<PendingOp, ValidationError[]> {
  return parseSchema(PendingOpSchema, input) as Result<PendingOp, ValidationError[]>;
}
