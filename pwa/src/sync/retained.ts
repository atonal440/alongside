import type { Task } from '../types';
import { describeIntent, intentWrites, type Intent } from './intent';
import { currentWorkspace } from './pull';
import { predictBase } from './base';
import { genId } from '../utils/genId';
import type { PendingOp, PendingOpPayload } from '../api/pendingOps';
import type { RetainedOp } from '../api/retainedOps';
import { idbDeleteRetainedOp, idbGetRetainedOps } from '../idb/retainedOps';
import { idbGetPendingOps, idbQueueOp } from '../idb/pendingOps';

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
    case 'command': return describeIntent(op.intent);
  }
}

const payloadOf = (op: PendingOp): PendingOpPayload => {
  const { id: _id, created_at: _c, attempts: _a, ...payload } = op;
  return payload as PendingOpPayload;
};

const createdId = (op: PendingOp): string | null =>
  op.op === 'task.create' ? op.localId : op.op === 'command' && op.intent.kind === 'task.create' ? op.intent.id : null;

/**
 * The retained ops to re-queue together when the user retries `target`: the op itself and,
 * for a refused create, the dependents that were retained because of it, in original order.
 */
export function retryGroup(all: readonly RetainedOp[], target: RetainedOp): RetainedOp[] {
  const ordered = [...all].sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  const localId = createdId(target.op);
  if (localId === null) return [target];
  return ordered.filter(r => r === target || (r.reason.kind === 'dependency' && r.reason.dependsOn === localId));
}

// Re-queue a retained op. A command is made again as a new command: fresh ID (the refused one may
// be remembered by the server) and a base revision predicted from the workspace as it is now, which
// is what makes retrying a conflict a rebase onto the current server state.
async function requeue(op: PendingOp, apiBase: string): Promise<void> {
  if (op.op !== 'command') { await idbQueueOp(payloadOf(op)); return; }
  const workspace = (await currentWorkspace(apiBase)) ?? { entities: new Map() };
  const identity = intentWrites(op.intent)[0]!;
  const base = op.intent.kind === 'task.create' ? null : predictBase(workspace, await idbGetPendingOps(), identity);
  await idbQueueOp({ op: 'command', commandId: genId('c'), intent: op.intent, base });
}

/** Put the user's intent back in the queue (original order) and forget the retained copies. */
export async function retryRetainedOp(id: number, apiBase = ''): Promise<number> {
  const all = await idbGetRetainedOps();
  const target = all.find(r => r.id === id);
  if (!target) return 0;
  const group = retryGroup(all, target);
  for (const r of group) {
    await requeue(r.op, apiBase);
    await idbDeleteRetainedOp(r.id!);
  }
  return group.length;
}

export interface FieldDiff {
  field: string;
  /** What the refused edit tried to set. */
  intended: unknown;
  /** What the task holds now. */
  current: unknown;
  /** False when the task already has the intended value, so resubmitting it would be a no-op. */
  differs: boolean;
}

export type RebaseView =
  | { kind: 'fields'; fields: FieldDiff[] }
  | { kind: 'missing'; message: string }
  | { kind: 'plain' };

/**
 * Compare a refused edit with the task as it is now, so the user can keep only the parts
 * that still make sense. Only task edits have per-field intent; everything else retries as is,
 * except that an op aimed at a task that no longer exists cannot be retried at all.
 */
// The task fields an intent sets, as [task field, intended value] pairs. Only edit intents have any.
export function intentFields(intent: Intent): [string, unknown][] {
  switch (intent.kind) {
    case 'task.content': return [['title', intent.title], ['notes', intent.notes], ['kickoff_note', intent.kickoffNote], ['session_log', intent.sessionLog]].filter(([, v]) => v !== undefined) as [string, unknown][];
    case 'task.type': return [['task_type', intent.taskType]];
    case 'task.project': return [['project_id', intent.projectId]];
    case 'task.schedule': return [['due_date', intent.dueDate], ['due_all_day', intent.dueAllDay], ['recurrence', intent.recurrence]].filter(([, v]) => v !== undefined) as [string, unknown][];
    case 'task.defer': return [['defer_kind', intent.defer.kind], ['defer_until', intent.defer.kind === 'until' ? intent.defer.until : null]];
    case 'task.focus': return [['focused_until', intent.focusedUntil]];
    default: return [];
  }
}

/** Keep only the chosen task fields of an edit intent; null when nothing of it remains. */
export function restrictIntent(intent: Intent, fields: readonly string[]): Intent | null {
  const keep = (name: string) => fields.includes(name);
  switch (intent.kind) {
    case 'task.content': {
      const out: Extract<Intent, { kind: 'task.content' }> = { kind: 'task.content', id: intent.id };
      if (intent.title !== undefined && keep('title')) out.title = intent.title;
      if (intent.notes !== undefined && keep('notes')) out.notes = intent.notes;
      if (intent.kickoffNote !== undefined && keep('kickoff_note')) out.kickoffNote = intent.kickoffNote;
      if (intent.sessionLog !== undefined && keep('session_log')) out.sessionLog = intent.sessionLog;
      return Object.keys(out).length > 2 ? out : null;
    }
    case 'task.schedule': {
      const out: Extract<Intent, { kind: 'task.schedule' }> = { kind: 'task.schedule', id: intent.id };
      if (intent.dueDate !== undefined && keep('due_date')) out.dueDate = intent.dueDate;
      if (intent.dueAllDay !== undefined && keep('due_all_day')) out.dueAllDay = intent.dueAllDay;
      if (intent.recurrence !== undefined && keep('recurrence')) out.recurrence = intent.recurrence;
      return Object.keys(out).length > 2 ? out : null;
    }
    default:
      return intentFields(intent).some(([field]) => keep(field)) ? intent : null;
  }
}

export function rebaseView(retained: RetainedOp, tasks: readonly Task[]): RebaseView {
  const op = retained.op;
  if (op.op === 'command') {
    const intent = op.intent;
    if (intent.kind === 'task.create' || intent.kind === 'link.add' || intent.kind === 'link.remove') return { kind: 'plain' };
    const task = tasks.find(t => t.id === intent.id);
    if (!task) return { kind: 'missing', message: 'That task no longer exists.' };
    const fields = intentFields(intent);
    if (fields.length === 0) return { kind: 'plain' };
    const record = task as unknown as Record<string, unknown>;
    return { kind: 'fields', fields: fields.map(([field, intended]) => ({ field, intended, current: record[field] ?? null, differs: (record[field] ?? null) !== (intended ?? null) })) };
  }
  if (op.op === 'task.update' || op.op === 'task.complete' || op.op === 'task.delete') {
    const task = tasks.find(t => t.id === op.taskId);
    if (!task) return { kind: 'missing', message: 'That task no longer exists.' };
    if (op.op !== 'task.update') return { kind: 'plain' };
    const record = task as unknown as Record<string, unknown>;
    return {
      kind: 'fields',
      fields: Object.entries(op.body).map(([field, intended]) => ({ field, intended, current: record[field] ?? null, differs: (record[field] ?? null) !== (intended ?? null) })),
    };
  }
  return { kind: 'plain' };
}

/** Re-queue a refused task edit keeping only `fields`; with none selected it is just discarded. */
export async function retryRebased(id: number, fields: readonly string[], apiBase = ''): Promise<number> {
  const all = await idbGetRetainedOps();
  const target = all.find(r => r.id === id);
  if (!target) return 0;
  if (target.op.op === 'command') {
    const kept = restrictIntent(target.op.intent, fields);
    if (kept !== null) await requeue({ ...target.op, intent: kept }, apiBase);
    await idbDeleteRetainedOp(id);
    return 1;
  }
  if (target.op.op !== 'task.update') return 0;
  const kept = Object.fromEntries(Object.entries(target.op.body).filter(([field]) => fields.includes(field)));
  if (Object.keys(kept).length > 0) await idbQueueOp({ op: 'task.update', taskId: target.op.taskId, body: kept });
  await idbDeleteRetainedOp(id);
  return 1;
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
