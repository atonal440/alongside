import type { Task } from '../types';
import type { PendingOp, PendingOpPayload } from '../api/pendingOps';
import type { RetainedOp } from '../api/retainedOps';
import { idbDeleteRetainedOp, idbGetRetainedOps } from '../idb/retainedOps';
import { idbQueueOp } from '../idb/pendingOps';
import { idbGetAllTasks, idbPutTask } from '../idb/tasks';
import { newLocalTask } from '../domain/taskMutations';
import type { IsoDateTime, NonEmptyString } from '@shared/parse';

/** One-line description of the intent a retained op preserves. */
export function describeRetainedOp(retained: RetainedOp): string {
  const op = retained.op;
  switch (op.op) {
    case 'task.create': return `Create “${op.body.title}”`;
    case 'task.update': return `Edit task ${Object.keys(op.body).join(', ') || '(no fields)'}`;
    case 'task.complete': return 'Complete a task';
    case 'task.delete': return 'Delete a task';
    case 'link.create': return `Link tasks (${op.body.link_type})`;
    case 'link.delete': return `Unlink tasks (${op.body.link_type})`;
  }
}

const payloadOf = (op: PendingOp): PendingOpPayload => {
  const { id: _id, created_at: _c, attempts: _a, ...payload } = op;
  return payload as PendingOpPayload;
};

/**
 * The retained ops to re-queue together when the user retries `target`: the op itself and,
 * for a refused create, the dependents that were retained because of it, in original order.
 */
export function retryGroup(all: readonly RetainedOp[], target: RetainedOp): RetainedOp[] {
  const ordered = [...all].sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  if (target.op.op !== 'task.create') return [target];
  const localId = target.op.localId;
  return ordered.filter(r => r === target || (r.reason.kind === 'dependency' && r.reason.dependsOn === localId));
}

/** Put the user's intent back in the queue (original order) and forget the retained copies. */
export async function retryRetainedOp(id: number): Promise<number> {
  const all = await idbGetRetainedOps();
  const target = all.find(r => r.id === id);
  if (!target) return 0;
  const group = retryGroup(all, target);
  for (const r of group) {
    if (r.op.op === 'task.create') {
      const known = (await idbGetAllTasks()).some(t => t.id === (r.op as Extract<PendingOp, { op: 'task.create' }>).localId);
      if (!known) {
        const { localId, body } = r.op;
        await idbPutTask({ ...newLocalTask(body.title as NonEmptyString<200>, new Date().toISOString() as IsoDateTime, localId), ...body } as Task);
      }
    }
    await idbQueueOp(payloadOf(r.op));
    await idbDeleteRetainedOp(r.id!);
  }
  return group.length;
}

/** Abandon the user's intent for this op (and, for a refused create, its dependents). */
export async function discardRetainedOp(id: number): Promise<number> {
  const all = await idbGetRetainedOps();
  const target = all.find(r => r.id === id);
  if (!target) return 0;
  const group = retryGroup(all, target);
  for (const r of group) await idbDeleteRetainedOp(r.id!);
  return group.length;
}
