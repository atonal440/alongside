import type { Task } from '../types';
import type { Result } from '@shared/result';
import { err } from '@shared/result';
import type { ValidationError } from '@shared/parse';
import { parseCommandEnvelope, type CommandEnvelope } from '@shared/wire/commands';
import type { PendingOp } from '../api/pendingOps';

export type CommandOp = Extract<PendingOp, { op: 'command' }>;

/** What the server said about the target right before sending: its row, and the aggregate revision. */
export interface BuildContext {
  /** Current server row of the task the intent writes (null when it does not exist, e.g. a create). */
  row: Task | null;
  structuralRevision: number;
  /** Current revision of the project a task is being moved into, when relevant. */
  projectRevision: number | null;
}

const missingBase = (): Result<CommandEnvelope, ValidationError[]> => err([{ path: ['base'], code: 'missing_base', message: 'This command has no base revision to guard against.' }]);
const missingRow = (id: string): Result<CommandEnvelope, ValidationError[]> => err([{ path: ['intent', 'id'], code: 'task_missing', message: `Task ${id} does not exist on the server.` }]);

/**
 * Turn a queued intent into the server's command envelope, filling in the guards at send time:
 * the entity revision it was made against (`op.base`, the conflict signal), the current aggregate
 * revision (a graph change elsewhere should not fail an unrelated create), and the current row for
 * commands that replace several fields at once. The result is parsed with the shared envelope
 * schema, so anything the server would reject on shape fails here without a request.
 */
export function buildEnvelope(op: CommandOp, ctx: BuildContext): Result<CommandEnvelope, ValidationError[]> {
  const { intent, base } = op;
  const S = ctx.structuralRevision;
  const wrap = (command: Record<string, unknown>) => parseCommandEnvelope({ contractVersion: 2, commandId: op.commandId, actor: 'user', commands: [command] });
  if (intent.kind === 'task.create') {
    return wrap({ kind: 'task.create', id: intent.id, expectedRevision: null, expectedStructuralRevision: S,
      values: { title: intent.title, notes: intent.notes, kickoffNote: intent.kickoffNote, taskType: intent.taskType, project: null } });
  }
  if (intent.kind === 'link.add') {
    // A link identity never seen before has no revision to guard (null); a tombstone has one.
    const [from, to] = intent.linkType === 'related' && intent.from > intent.to ? [intent.to, intent.from] : [intent.from, intent.to];
    return wrap({ kind: 'link.add', from, to, linkType: intent.linkType, expectedRevision: base, expectedStructuralRevision: S });
  }
  if (base === null) return missingBase();
  if (intent.kind === 'link.remove') {
    return wrap({ kind: 'link.remove', from: intent.from, to: intent.to, linkType: intent.linkType, expectedRevision: base, expectedStructuralRevision: S });
  }
  const row = ctx.row;
  if (row === null) return missingRow(intent.id);
  const id = intent.id;
  switch (intent.kind) {
    case 'task.content':
      return wrap({ kind: 'task.content.set', id, expectedRevision: base, values: {
        title: intent.title ?? row.title, notes: intent.notes !== undefined ? intent.notes : row.notes,
        kickoffNote: intent.kickoffNote !== undefined ? intent.kickoffNote : row.kickoff_note,
        sessionLog: intent.sessionLog !== undefined ? intent.sessionLog : row.session_log } });
    case 'task.type': return wrap({ kind: 'task.type.set', id, expectedRevision: base, taskType: intent.taskType });
    case 'task.project':
      return wrap({ kind: 'task.project.set', id, expectedRevision: base, expectedStructuralRevision: S,
        project: intent.projectId === null ? null : { id: intent.projectId, expectedRevision: ctx.projectRevision ?? 0 } });
    case 'task.schedule':
      return wrap({ kind: 'task.legacy-schedule.set', id, expectedRevision: base, values: {
        dueDate: intent.dueDate !== undefined ? intent.dueDate : row.due_date,
        dueAllDay: intent.dueAllDay !== undefined ? intent.dueAllDay : row.due_all_day,
        recurrence: intent.recurrence !== undefined ? intent.recurrence : row.recurrence } });
    case 'task.defer': return wrap({ kind: 'task.defer.set', id, expectedRevision: base, defer: intent.defer });
    case 'task.focus': return wrap({ kind: 'task.focus.set', id, expectedRevision: base, focusedUntil: intent.focusedUntil });
    case 'task.reopen': return wrap({ kind: 'task.reopen', id, expectedRevision: base });
    case 'task.complete':
      return wrap({ kind: 'task.complete', id, expectedRevision: base, expectedStructuralRevision: S,
        successor: row.recurrence !== null && intent.successorId !== null ? { id: intent.successorId } : null });
    case 'task.delete': return wrap({ kind: 'task.delete', id, expectedRevision: base, expectedStructuralRevision: S });
  }
}
