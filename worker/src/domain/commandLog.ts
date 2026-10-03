/**
 * Action-log entries for commands applied through the MCP `apply_changes` tool. One row per
 * command, in declared order, recording the command kind as `tool_name` (the sync codec accepts
 * kinds since protocol 3). Settings commands are configuration, not activity, so they are not
 * logged, matching `update_preference`. The rows are written in the same atomic plan as the
 * receipt, so a replay writes none and a failed command leaves none.
 */
import type { ChangesResult, CommandEnvelope } from '@shared/wire/commands';
import type { ToolLogDraft } from '../db';

type Command = CommandEnvelope['commands'][number];
type Change = ChangesResult['changes'][number];

interface Titles { task: Map<string, string>; project: Map<string, string> }

/** Titles visible in the result (after-image, or before-image for a deletion). */
export function titlesFrom(result: ChangesResult): Titles {
  const titles: Titles = { task: new Map(), project: new Map() };
  for (const change of result.changes) {
    if (change.entity !== 'task' && change.entity !== 'project') continue;
    const row = 'row' in change.after ? change.after.row : change.before?.row;
    if (row) titles[change.entity].set(change.id, row.title);
  }
  return titles;
}

/** Task IDs named by link commands whose titles the result may not hold. */
export function linkEndpoints(input: CommandEnvelope): string[] {
  return input.commands.flatMap(command => command.kind === 'link.add' || command.kind === 'link.remove' ? [command.from, command.to] : []);
}

function draft(command: Command, result: ChangesResult, titles: Titles, extraTaskTitles: Map<string, string>): ToolLogDraft | null {
  const taskTitle = (id: string) => titles.task.get(id) ?? extraTaskTitles.get(id) ?? id;
  const task = (id: string, detail: string | null = null): ToolLogDraft => ({ tool_name: command.kind, task_id: id, title: taskTitle(id), detail });
  const project = (id: string, detail: string | null = null): ToolLogDraft => ({ tool_name: command.kind, task_id: null, title: titles.project.get(id) ?? id, detail });
  switch (command.kind) {
    case 'planning.set': case 'preference.set': return null;
    case 'task.create': case 'task.content.set': case 'task.reopen': case 'task.delete': return task(command.id);
    case 'task.type.set': return task(command.id, command.taskType);
    case 'task.legacy-schedule.set': return task(command.id, command.values.dueDate ?? 'cleared');
    case 'task.focus.set': return task(command.id, command.focusedUntil ?? 'cleared');
    case 'task.defer.set': return task(command.id, command.defer.kind === 'until' ? command.defer.until : command.defer.kind);
    case 'task.project.set': return task(command.id, command.project ? titles.project.get(command.project.id) ?? command.project.id : 'removed');
    case 'task.complete': {
      const next = command.successor ? result.changes.find(change => change.entity === 'task' && change.id === command.successor!.id) : undefined;
      const due = next && next.entity === 'task' && 'row' in next.after ? next.after.row.due_date : null;
      return task(command.id, due ? `→ recurs ${due}` : null);
    }
    case 'project.create': case 'project.content.set': case 'project.archive': case 'project.reopen': case 'project.delete': return project(command.id);
    case 'link.add': case 'link.remove':
      return { tool_name: command.kind, task_id: null, title: `${taskTitle(command.from)} → ${taskTitle(command.to)}`, detail: command.linkType };
  }
}

export function commandLogDrafts(input: CommandEnvelope, result: ChangesResult, extraTaskTitles: Map<string, string> = new Map()): ToolLogDraft[] {
  const titles = titlesFrom(result);
  return input.commands.flatMap(command => { const log = draft(command, result, titles, extraTaskTitles); return log ? [log] : []; });
}
