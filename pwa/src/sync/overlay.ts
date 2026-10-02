import type { Task, TaskLink, Project } from '../types';
import type { IsoDateTime } from '@shared/parse';
import type { PendingOp } from '../api/pendingOps';
import { applyComplete, applyUpdate, type TaskUpdatePatch } from '../domain/taskMutations';
import type { CanonicalWorkspace } from './canonical';

/**
 * What the user sees: the canonical workspace with the ordered pending-op queue
 * replayed on top. Pure and total — the canonical store and queue are never
 * mutated, and an op that no longer applies is reported, not dropped or thrown.
 */
export type OverlayOutcome =
  | { kind: 'applied' }
  | { kind: 'skipped'; reason: 'task_missing' | 'task_exists' | 'invalid' | 'link_exists' | 'link_missing' | 'endpoint_missing'; message: string };

export interface OverlayView {
  tasks: Task[];
  projects: Project[];
  links: TaskLink[];
  /** One entry per input op, in queue order. */
  outcomes: OverlayOutcome[];
}

const linkKey = (l: Pick<TaskLink, 'from_task_id' | 'to_task_id' | 'link_type'>) => `${l.from_task_id}\n${l.to_task_id}\n${l.link_type}`;
const skipped = (reason: Extract<OverlayOutcome, { kind: 'skipped' }>['reason'], message: string): OverlayOutcome => ({ kind: 'skipped', reason, message });

export function overlayPendingOps(base: CanonicalWorkspace, ops: readonly PendingOp[]): OverlayView {
  const tasks = new Map<string, Task>();
  const links = new Map<string, TaskLink>();
  const projects: Project[] = [];
  for (const image of base.entities.values()) {
    if (image.row === null) continue;
    if (image.entity === 'task') tasks.set(image.key, image.row);
    else if (image.entity === 'link') links.set(linkKey(image.row), image.row);
    else if (image.entity === 'project') projects.push(image.row);
  }

  const outcomes = ops.map((op): OverlayOutcome => {
    const at = op.created_at as IsoDateTime;
    switch (op.op) {
      case 'task.create': {
        if (tasks.has(op.localId)) return skipped('task_exists', `Task ${op.localId} already exists.`);
        const { body } = op;
        tasks.set(op.localId, {
          id: op.localId, title: body.title, notes: body.notes ?? null, status: 'pending',
          due_date: body.due_date ?? null, due_all_day: body.due_date ? (body.due_all_day ?? null) : null,
          recurrence: body.recurrence ?? null, created_at: at, updated_at: at, defer_until: null, defer_kind: 'none',
          task_type: body.task_type ?? 'action', project_id: body.project_id ?? null, kickoff_note: body.kickoff_note ?? null,
          session_log: null, focused_until: null, duty_id: null, occurrence_at: null,
        } as Task);
        return { kind: 'applied' };
      }
      case 'task.update': {
        const task = tasks.get(op.taskId);
        if (!task) return skipped('task_missing', `Task ${op.taskId} is not in the workspace.`);
        const result = applyUpdate(task, op.body as TaskUpdatePatch, at);
        if (!result.ok) return skipped('invalid', result.error.message);
        tasks.set(op.taskId, result.value.task);
        return { kind: 'applied' };
      }
      case 'task.complete': {
        const task = tasks.get(op.taskId);
        if (!task) return skipped('task_missing', `Task ${op.taskId} is not in the workspace.`);
        const result = applyComplete(task, at);
        if (!result.ok) return skipped('invalid', result.error.message);
        tasks.set(op.taskId, result.value.task);
        return { kind: 'applied' };
      }
      case 'task.delete': {
        if (!tasks.delete(op.taskId)) return skipped('task_missing', `Task ${op.taskId} is not in the workspace.`);
        for (const [key, link] of links) if (link.from_task_id === op.taskId || link.to_task_id === op.taskId) links.delete(key);
        return { kind: 'applied' };
      }
      case 'link.create': {
        const { from_task_id: from, to_task_id: to } = op.body;
        if (!tasks.has(from) || !tasks.has(to)) return skipped('endpoint_missing', 'A linked task is not in the workspace.');
        if (links.has(linkKey(op.body))) return skipped('link_exists', 'The link already exists.');
        links.set(linkKey(op.body), op.body as TaskLink);
        return { kind: 'applied' };
      }
      case 'link.delete':
        return links.delete(linkKey(op.body)) ? { kind: 'applied' } : skipped('link_missing', 'The link is not in the workspace.');
    }
  });

  return { tasks: [...tasks.values()], projects, links: [...links.values()], outcomes };
}
