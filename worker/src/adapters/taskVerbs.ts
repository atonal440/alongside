/**
 * The quick verbs: add_task, update_task, complete_task, defer_task, focus_task. Each keeps the
 * legacy argument shape and response, and compiles to the commands apply_changes would run.
 * Behavior differences from the legacy handlers are listed in docs/plans/mcp-parity-matrix.md.
 */
import { parseDueDateParts } from '@shared/parse';
import { parsePositiveFinite } from '../parse';
import { derivedId, notFound, refuse, taskRowOf, type Compiler, type Ctx, type Json } from './runner';
import type { ToolLogDraft } from '../db';

const DEFAULT_FOCUS_HOURS = 3;
const MAX_FOCUS_HOURS = 24;

const str = (args: Json, key: string): string => {
  if (typeof args[key] !== 'string') throw refuse(`${key} must be a string.`, [key]);
  return args[key] as string;
};
const entry = (log: ToolLogDraft) => ({ tool_name: log.tool_name, title: log.title, detail: log.detail });

async function liveTask(ctx: Ctx, id: string) {
  const snapshot = await ctx.read('task', id);
  if (snapshot.entity !== 'task' || snapshot.row === null || snapshot.version === null) throw notFound('Task not found');
  return { row: snapshot.row, revision: snapshot.version.revision as number };
}
async function projectRef(ctx: Ctx, id: unknown, path: string[]) {
  if (id === null) return null;
  if (typeof id !== 'string') throw refuse('project_id must be a string or null.', path);
  const snapshot = await ctx.read('project', id);
  if (snapshot.row === null || snapshot.version === null) throw notFound('Project not found');
  return { id, expectedRevision: snapshot.version.revision as number };
}
/** Legacy due-date resolution: a bare date is all-day at noon UTC, an instant is a timed due date. */
function dueParts(input: unknown, explicitAllDay?: boolean | null) {
  const parsed = parseDueDateParts(input);
  if (!parsed.ok) throw refuse(parsed.error[0]?.message ?? 'Invalid due date.', ['due_date']);
  return { dueDate: parsed.value.due_date as string, dueAllDay: explicitAllDay ?? parsed.value.due_all_day };
}

export const addTask: Compiler = async (ctx, args) => {
  const id = await derivedId('t', ctx.commandId, 0);
  const project = args.project_id === undefined ? null : await projectRef(ctx, args.project_id, ['project_id']);
  const commands: Json[] = [{ kind: 'task.create', id, expectedRevision: null, expectedStructuralRevision: ctx.structural,
    values: { title: args.title, notes: args.notes ?? null, kickoffNote: args.kickoff_note ?? null, taskType: args.task_type ?? 'action', project } }];
  const recurrence = args.recurrence ?? null;
  if ((args.due_date ?? null) !== null || recurrence !== null) {
    const due = args.due_date === undefined || args.due_date === null ? { dueDate: null, dueAllDay: null } : dueParts(args.due_date);
    commands.push({ kind: 'task.legacy-schedule.set', id, expectedRevision: 1, values: { ...due, recurrence } });
  }
  return { kind: 'commands', commands, respond: result => {
    const row = taskRowOf(result, id);
    const log: ToolLogDraft = { tool_name: 'add_task', task_id: id, title: row.title, detail: row.due_date ?? null };
    return { response: { ...row, action_log_entry: entry(log) }, log };
  } };
};

export const completeTask: Compiler = async (ctx, args) => {
  const id = str(args, 'task_id');
  const { row, revision } = await liveTask(ctx, id);
  const successor = row.recurrence !== null ? { id: await derivedId('t', ctx.commandId, 0) } : null;
  return { kind: 'commands', commands: [{ kind: 'task.complete', id, expectedRevision: ctx.expectedRevision ?? revision, expectedStructuralRevision: ctx.structural, successor }],
    respond: result => {
      const completed = taskRowOf(result, id);
      const next = successor ? taskRowOf(result, successor.id) : undefined;
      const log: ToolLogDraft = { tool_name: 'complete_task', task_id: id, title: completed.title, detail: next ? `→ recurs ${next.due_date}` : null };
      return { response: { completed, ...(next ? { next } : {}), action_log_entry: entry(log) }, log };
    } };
};

export const deferTask: Compiler = async (ctx, args) => {
  const id = str(args, 'task_id');
  const kind = args.kind;
  if (kind !== 'until' && kind !== 'someday') throw refuse('kind must be "until" or "someday"', ['kind']);
  const until = args.until as string | undefined;
  if (kind === 'until' && !until) throw refuse('until is required when kind="until"', ['until']);
  if (kind === 'someday' && until !== undefined && until !== null) throw refuse('until must be omitted when kind is someday.', ['until']);
  const { revision } = await liveTask(ctx, id);
  const defer = kind === 'someday' ? { kind: 'someday' } : { kind: 'until', until };
  return { kind: 'commands', commands: [{ kind: 'task.defer.set', id, expectedRevision: ctx.expectedRevision ?? revision, defer }],
    respond: result => {
      const row = taskRowOf(result, id);
      const log: ToolLogDraft = { tool_name: 'defer_task', task_id: id, title: row.title, detail: kind === 'someday' ? 'someday' : (until ?? '') };
      return { response: { ...row, action_log_entry: entry(log) }, log };
    } };
};

export const focusTask: Compiler = async (ctx, args) => {
  const id = str(args, 'task_id');
  let hours = DEFAULT_FOCUS_HOURS;
  if (args.hours !== undefined) {
    const parsed = parsePositiveFinite(MAX_FOCUS_HOURS, args.hours);
    if (!parsed.ok) throw refuse(`hours must be a finite positive number no greater than ${MAX_FOCUS_HOURS}: ${parsed.error.map(e => e.message).join('; ')}`, ['hours']);
    hours = parsed.value;
  }
  const { revision } = await liveTask(ctx, id);
  const focusedUntil = new Date(Date.now() + hours * 3600000).toISOString();
  return { kind: 'commands', commands: [{ kind: 'task.focus.set', id, expectedRevision: ctx.expectedRevision ?? revision, focusedUntil }],
    respond: result => {
      const row = taskRowOf(result, id);
      const log: ToolLogDraft = { tool_name: 'focus_task', task_id: id, title: row.title, detail: `${hours}h` };
      return { response: { ...row, action_log_entry: entry(log) }, log };
    } };
};

export const updateTask: Compiler = async (ctx, args) => {
  const { task_id: _taskId, ...patch } = args;
  const id = str(args, 'task_id');
  if (patch.status === 'done') throw refuse('Use complete_task to mark a task done.', ['status']);
  if (patch.status !== undefined && patch.status !== 'pending') throw refuse('status must be "pending".', ['status']);
  const { row, revision } = await liveTask(ctx, id);
  const base = ctx.expectedRevision ?? revision;
  const commands: Json[] = [];
  // Commands on one task compose: the first names the live revision, later ones the revision after it.
  const guard = () => commands.length === 0 ? base : base + 1;

  if (patch.status === 'pending' && row.status === 'done') commands.push({ kind: 'task.reopen', id, expectedRevision: guard() });

  if (['title', 'notes', 'kickoff_note', 'session_log'].some(key => patch[key] !== undefined)) {
    const pick = (key: 'title' | 'notes' | 'kickoff_note' | 'session_log') => patch[key] !== undefined ? patch[key] : row[key];
    commands.push({ kind: 'task.content.set', id, expectedRevision: guard(), values: { title: pick('title'), notes: pick('notes'), kickoffNote: pick('kickoff_note'), sessionLog: pick('session_log') } });
  }

  if (patch.due_date !== undefined || patch.due_all_day !== undefined || patch.recurrence !== undefined) {
    let dueDate: string | null, dueAllDay: boolean | null;
    if (patch.due_date !== undefined) {
      ({ dueDate, dueAllDay } = patch.due_date === null ? { dueDate: null, dueAllDay: null } : dueParts(patch.due_date, patch.due_all_day as boolean | null | undefined));
    } else {
      dueDate = row.due_date;
      dueAllDay = patch.due_all_day !== undefined ? patch.due_all_day as boolean | null : row.due_all_day;
    }
    commands.push({ kind: 'task.legacy-schedule.set', id, expectedRevision: guard(), values: { dueDate, dueAllDay, recurrence: patch.recurrence !== undefined ? patch.recurrence : row.recurrence } });
  }

  if (patch.task_type !== undefined) commands.push({ kind: 'task.type.set', id, expectedRevision: guard(), taskType: patch.task_type });

  if (patch.project_id !== undefined) {
    commands.push({ kind: 'task.project.set', id, expectedRevision: guard(), expectedStructuralRevision: ctx.structural, project: await projectRef(ctx, patch.project_id, ['project_id']) });
  }

  // Undeclared but accepted today: defer_kind / defer_until map to task.defer.set (parity finding 1).
  if (patch.defer_kind !== undefined) {
    const kind = patch.defer_kind;
    if (kind !== 'none' && kind !== 'someday' && kind !== 'until') throw refuse('defer_kind must be "none", "someday" or "until".', ['defer_kind']);
    commands.push({ kind: 'task.defer.set', id, expectedRevision: guard(), defer: kind === 'until' ? { kind, until: patch.defer_until } : { kind } });
  } else if (patch.defer_until !== undefined) {
    throw refuse('defer_until needs defer_kind; use defer_task to defer a task.', ['defer_until']);
  }

  if (patch.focused_until !== undefined) {
    // Clearing focus on a done task is a no-op (completion already cleared it); setting it is refused, as today.
    if (patch.focused_until !== null || row.status === 'pending') {
      if (patch.focused_until !== null && row.status !== 'pending') throw refuse('Only pending tasks can change focus.', ['focused_until']);
      commands.push({ kind: 'task.focus.set', id, expectedRevision: guard(), focusedUntil: patch.focused_until });
    }
  }

  const titleOf = (title: string): ToolLogDraft => ({ tool_name: 'update_task', task_id: id, title, detail: null });
  if (commands.length === 0) {
    // Nothing to write, but the legacy handler still logs and answers with the current task.
    if (typeof ctx.expectedRevision === 'number' && ctx.expectedRevision !== revision) {
      throw await staleRevision(ctx, id, ctx.expectedRevision, revision);
    }
    const log = titleOf(row.title);
    return { kind: 'noop', guards: [{ kind: 'entity.revision', key: { entity: 'task', id } as never, expected: revision as never }], response: { ...row, action_log_entry: entry(log) }, log };
  }
  return { kind: 'commands', commands, respond: result => {
    const updated = taskRowOf(result, id);
    const log = titleOf(updated.title);
    return { response: { ...updated, action_log_entry: entry(log) }, log };
  } };
};

import { CommandError } from '../domain/commands';
async function staleRevision(ctx: Ctx, id: string, expected: number, actual: number): Promise<CommandError> {
  return new CommandError({ code: 'revision_conflict', path: ['expectedRevision'], message: `Task ${id} is at revision ${actual}, not ${expected}.`, retryable: false,
    expectedRevision: expected as never, recoveryHint: 'Read the task with get_context and repeat the call against its current revision.' });
}
