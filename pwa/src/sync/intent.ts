import * as v from 'valibot';
import type { Task, TaskLink } from '../types';
import type { TaskUpdatePatch } from '../domain/taskMutations';

/**
 * What a queued command means, independent of when it is sent. Each intent maps to exactly one
 * server command (`shared/wire/commands.ts`); the envelope is built at send time from the current
 * row and structural revision (`envelope.ts`). Intents are deliberately one-identity-per-command so
 * a multi-field edit becomes several independent, individually reviewable commands.
 */
export type Intent =
  | { kind: 'task.create'; id: string; title: string; notes: string | null; kickoffNote: string | null; taskType: string }
  | { kind: 'task.content'; id: string; title?: string; notes?: string | null; kickoffNote?: string | null; sessionLog?: string | null }
  | { kind: 'task.type'; id: string; taskType: string }
  | { kind: 'task.project'; id: string; projectId: string | null }
  | { kind: 'task.schedule'; id: string; dueDate?: string | null; dueAllDay?: boolean | null; recurrence?: string | null }
  | { kind: 'task.defer'; id: string; defer: { kind: 'none' } | { kind: 'someday' } | { kind: 'until'; until: string } }
  | { kind: 'task.focus'; id: string; focusedUntil: string | null }
  | { kind: 'task.reopen'; id: string }
  | { kind: 'task.complete'; id: string; successorId: string | null }
  | { kind: 'task.delete'; id: string }
  | { kind: 'link.add'; from: string; to: string; linkType: TaskLink['link_type'] }
  | { kind: 'link.remove'; from: string; to: string; linkType: TaskLink['link_type'] };

const str = v.string();
const nstr = v.nullable(v.string());
const linkType = v.picklist(['blocks', 'related']);
export const IntentSchema = v.variant('kind', [
  v.object({ kind: v.literal('task.create'), id: str, title: str, notes: nstr, kickoffNote: nstr, taskType: str }),
  v.object({ kind: v.literal('task.content'), id: str, title: v.optional(str), notes: v.optional(nstr), kickoffNote: v.optional(nstr), sessionLog: v.optional(nstr) }),
  v.object({ kind: v.literal('task.type'), id: str, taskType: str }),
  v.object({ kind: v.literal('task.project'), id: str, projectId: nstr }),
  v.object({ kind: v.literal('task.schedule'), id: str, dueDate: v.optional(nstr), dueAllDay: v.optional(v.nullable(v.boolean())), recurrence: v.optional(nstr) }),
  v.object({ kind: v.literal('task.defer'), id: str, defer: v.variant('kind', [v.object({ kind: v.literal('none') }), v.object({ kind: v.literal('someday') }), v.object({ kind: v.literal('until'), until: str })]) }),
  v.object({ kind: v.literal('task.focus'), id: str, focusedUntil: nstr }),
  v.object({ kind: v.literal('task.reopen'), id: str }),
  v.object({ kind: v.literal('task.complete'), id: str, successorId: nstr }),
  v.object({ kind: v.literal('task.delete'), id: str }),
  v.object({ kind: v.literal('link.add'), from: str, to: str, linkType }),
  v.object({ kind: v.literal('link.remove'), from: str, to: str, linkType }),
]);

/** The task a task-scoped intent writes, or null for link intents. */
export function intentTaskId(intent: Intent): string | null {
  return intent.kind === 'link.add' || intent.kind === 'link.remove' ? null : intent.id;
}

/** Identity keys (`task:<id>`, `link:<json>`) this intent writes; used to predict revisions. */
export function intentWrites(intent: Intent): string[] {
  if (intent.kind === 'link.add' || intent.kind === 'link.remove') return [linkIdentity(intent.from, intent.to, intent.linkType)];
  return [`task:${intent.id}`, ...(intent.kind === 'task.complete' && intent.successorId ? [`task:${intent.successorId}`] : [])];
}

export const linkIdentity = (from: string, to: string, type: string): string => `link:${JSON.stringify([from, to, type])}`;

const minute = (iso: string): string => `${new Date(iso).toISOString().slice(0, 16)}:00Z`;

/**
 * Split a local edit into the commands that carry it. Only fields that actually differ from the
 * task's current values become commands, so saving an unchanged form queues nothing. A defer change
 * clears focus on the server and a focus change clears defer, so each is a single command.
 */
export function intentsFromPatch(task: Task, patch: TaskUpdatePatch & { status?: string }): Intent[] {
  const out: Intent[] = [];
  const differs = <K extends keyof Task>(key: K): boolean => key in patch && (patch as Record<string, unknown>)[key] !== task[key];

  const content: Extract<Intent, { kind: 'task.content' }> = { kind: 'task.content', id: task.id };
  if (differs('title')) content.title = patch.title as string;
  if (differs('notes')) content.notes = patch.notes ?? null;
  if (differs('kickoff_note')) content.kickoffNote = patch.kickoff_note ?? null;
  if (differs('session_log')) content.sessionLog = patch.session_log ?? null;
  if (Object.keys(content).length > 2) out.push(content);

  if (differs('task_type')) out.push({ kind: 'task.type', id: task.id, taskType: patch.task_type as string });
  if (differs('project_id')) out.push({ kind: 'task.project', id: task.id, projectId: patch.project_id ?? null });

  if (differs('due_date') || differs('due_all_day') || differs('recurrence')) {
    const schedule: Extract<Intent, { kind: 'task.schedule' }> = { kind: 'task.schedule', id: task.id };
    if ('due_date' in patch) schedule.dueDate = patch.due_date ?? null;
    if ('due_all_day' in patch) schedule.dueAllDay = patch.due_all_day ?? null;
    if ('recurrence' in patch) schedule.recurrence = patch.recurrence ?? null;
    out.push(schedule);
  }

  if (patch.status === 'pending' && task.status === 'done') out.push({ kind: 'task.reopen', id: task.id });

  // Focusing also clears a defer on the server and deferring clears focus, so each is one command.
  if (patch.focused_until && differs('focused_until')) {
    out.push({ kind: 'task.focus', id: task.id, focusedUntil: minute(patch.focused_until) });
  } else if (differs('defer_kind') || differs('defer_until')) {
    const kind = patch.defer_kind ?? task.defer_kind;
    const until = 'defer_until' in patch ? patch.defer_until : task.defer_until;
    out.push({ kind: 'task.defer', id: task.id, defer: kind === 'until' && until ? { kind: 'until', until: minute(until) } : { kind: kind === 'someday' ? 'someday' : 'none' } });
  } else if (differs('focused_until')) {
    out.push({ kind: 'task.focus', id: task.id, focusedUntil: patch.focused_until ? minute(patch.focused_until) : null });
  }
  return out;
}

/** Apply one task-scoped intent to a task, as the server would, for the optimistic view. */
export function applyIntentToTask(task: Task, intent: Intent, at: string): Task {
  const touched = { ...task, updated_at: at };
  switch (intent.kind) {
    case 'task.content':
      return { ...touched,
        ...(intent.title !== undefined ? { title: intent.title } : {}),
        ...(intent.notes !== undefined ? { notes: intent.notes } : {}),
        ...(intent.kickoffNote !== undefined ? { kickoff_note: intent.kickoffNote } : {}),
        ...(intent.sessionLog !== undefined ? { session_log: intent.sessionLog } : {}) } as Task;
    case 'task.type': return { ...touched, task_type: intent.taskType } as Task;
    case 'task.project': return { ...touched, project_id: intent.projectId } as Task;
    case 'task.schedule':
      return { ...touched,
        ...(intent.dueDate !== undefined ? { due_date: intent.dueDate } : {}),
        ...(intent.dueAllDay !== undefined ? { due_all_day: intent.dueAllDay } : {}),
        ...(intent.recurrence !== undefined ? { recurrence: intent.recurrence } : {}) } as Task;
    case 'task.defer':
      return { ...touched, defer_kind: intent.defer.kind, defer_until: intent.defer.kind === 'until' ? intent.defer.until : null, focused_until: null } as Task;
    case 'task.focus':
      return { ...touched, focused_until: intent.focusedUntil, ...(intent.focusedUntil ? { defer_kind: 'none', defer_until: null } : {}) } as Task;
    case 'task.reopen': return { ...touched, status: 'pending' } as Task;
    case 'task.complete': return { ...touched, status: 'done', defer_kind: 'none', defer_until: null, focused_until: null } as Task;
    default: return task;
  }
}

/** A short human description for the "Needs attention" list. */
export function describeIntent(intent: Intent): string {
  switch (intent.kind) {
    case 'task.create': return `Create “${intent.title}”`;
    case 'task.content': return `Edit task ${['title', 'notes', 'kickoffNote', 'sessionLog'].filter(f => f in intent).join(', ')}`;
    case 'task.type': return 'Change task type';
    case 'task.project': return 'Move task to a project';
    case 'task.schedule': return 'Change due date or repeat';
    case 'task.defer': return 'Defer a task';
    case 'task.focus': return 'Focus a task';
    case 'task.reopen': return 'Reopen a task';
    case 'task.complete': return 'Complete a task';
    case 'task.delete': return 'Delete a task';
    case 'link.add': return `Link tasks (${intent.linkType})`;
    case 'link.remove': return `Unlink tasks (${intent.linkType})`;
  }
}
