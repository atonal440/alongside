/**
 * reopen_task, delete_task, create_project, update_project, delete_project, link_tasks and
 * unlink_tasks as adapters over the command planner. Differences from the legacy handlers are in
 * docs/plans/mcp-parity-matrix.md.
 */
import { notFound, projectRowOf, refuse, derivedId, taskRowOf, type Compiler, type Ctx, type Json } from './runner';
import { CommandError } from '../domain/commands';
import type { ToolLogDraft } from '../db';

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
async function liveProject(ctx: Ctx, id: string) {
  const snapshot = await ctx.read('project', id);
  if (snapshot.entity !== 'project' || snapshot.row === null || snapshot.version === null) throw notFound('Project not found');
  return { row: snapshot.row, revision: snapshot.version.revision as number };
}
function staleRevision(kind: string, id: string, expected: number, actual: number): CommandError {
  return new CommandError({ code: 'revision_conflict', path: ['expectedRevision'], message: `${kind} ${id} is at revision ${actual}, not ${expected}.`, retryable: false,
    expectedRevision: expected as never, recoveryHint: 'Read it with get_context and repeat the call against its current revision.' });
}

export const reopenTask: Compiler = async (ctx, args) => {
  const id = str(args, 'task_id');
  const { revision } = await liveTask(ctx, id);
  return { kind: 'commands', commands: [{ kind: 'task.reopen', id, expectedRevision: ctx.expectedRevision ?? revision }], respond: result => {
    const row = taskRowOf(result, id);
    const log: ToolLogDraft = { tool_name: 'reopen_task', task_id: id, title: row.title, detail: null };
    return { response: { ...row, action_log_entry: entry(log) }, log };
  } };
};

export const deleteTask: Compiler = async (ctx, args) => {
  const id = str(args, 'task_id');
  const { row, revision } = await liveTask(ctx, id);
  const log: ToolLogDraft = { tool_name: 'delete_task', task_id: id, title: row.title, detail: null };
  return { kind: 'commands', commands: [{ kind: 'task.delete', id, expectedRevision: ctx.expectedRevision ?? revision, expectedStructuralRevision: ctx.structural }],
    respond: () => ({ response: { deleted: true, task_id: id, title: row.title, action_log_entry: entry(log) }, log }) };
};

export const deleteProject: Compiler = async (ctx, args) => {
  const id = str(args, 'project_id');
  const { row, revision } = await liveProject(ctx, id);
  const log: ToolLogDraft = { tool_name: 'delete_project', task_id: null, title: row.title, detail: null };
  return { kind: 'commands', commands: [{ kind: 'project.delete', id, expectedRevision: ctx.expectedRevision ?? revision, expectedStructuralRevision: ctx.structural }],
    respond: () => ({ response: { deleted: true, project_id: id, title: row.title, action_log_entry: entry(log) }, log }) };
};

export const createProject: Compiler = async (ctx, args) => {
  if (args.task_ids !== undefined && (!Array.isArray(args.task_ids) || args.task_ids.some(id => typeof id !== 'string'))) throw refuse('task_ids must be an array of task IDs.', ['task_ids']);
  const taskIds = [...new Set((args.task_ids as string[] | undefined) ?? [])];
  const projectId = await derivedId('p', ctx.commandId, 0);
  const commands: Json[] = [{ kind: 'project.create', id: projectId, expectedRevision: null, expectedStructuralRevision: ctx.structural,
    values: { title: args.title, notes: args.notes ?? null, kickoffNote: args.kickoff_note ?? null } }];
  for (const taskId of taskIds) {
    const snapshot = await ctx.read('task', taskId);
    if (snapshot.row === null || snapshot.version === null) throw notFound(`task not found: ${taskId}`);
    commands.push({ kind: 'task.project.set', id: taskId, expectedRevision: snapshot.version.revision, expectedStructuralRevision: ctx.structural, project: { id: projectId, expectedRevision: 1 } });
  }
  return { kind: 'commands', commands, respond: result => {
    const project = projectRowOf(result, projectId);
    const log: ToolLogDraft = { tool_name: 'create_project', task_id: null, title: project.title, detail: taskIds.length > 0 ? `${taskIds.length} tasks` : null };
    return { response: { project, linked_task_count: taskIds.length, action_log_entry: entry(log) }, log };
  } };
};

export const updateProject: Compiler = async (ctx, args) => {
  const id = str(args, 'project_id');
  const { project_id: _id, ...patch } = args;
  if (patch.status !== undefined && patch.status !== 'active' && patch.status !== 'archived') throw refuse('status must be "active" or "archived".', ['status']);
  const { row, revision } = await liveProject(ctx, id);
  const base = ctx.expectedRevision ?? revision;
  const commands: Json[] = [];
  const guard = () => commands.length === 0 ? base : base + 1;
  if (['title', 'notes', 'kickoff_note'].some(key => patch[key] !== undefined)) {
    const pick = (key: 'title' | 'notes' | 'kickoff_note') => patch[key] !== undefined ? patch[key] : row[key];
    commands.push({ kind: 'project.content.set', id, expectedRevision: guard(), values: { title: pick('title'), notes: pick('notes'), kickoffNote: pick('kickoff_note') } });
  }
  if (patch.status === 'archived' && row.status === 'active') commands.push({ kind: 'project.archive', id, expectedRevision: guard() });
  if (patch.status === 'active' && row.status === 'archived') commands.push({ kind: 'project.reopen', id, expectedRevision: guard() });

  const logFor = (title: string): ToolLogDraft => ({ tool_name: 'update_project', task_id: null, title, detail: null });
  if (commands.length === 0) {
    if (typeof ctx.expectedRevision === 'number' && ctx.expectedRevision !== revision) throw staleRevision('Project', id, ctx.expectedRevision, revision);
    const log = logFor(row.title);
    return { kind: 'noop', guards: [{ kind: 'entity.revision', key: { entity: 'project', id } as never, expected: revision as never }], response: { ...row, action_log_entry: entry(log) }, log };
  }
  return { kind: 'commands', commands, respond: result => {
    const updated = projectRowOf(result, id);
    const log = logFor(updated.title);
    return { response: { ...updated, action_log_entry: entry(log) }, log };
  } };
};

function linkType(args: Json): 'blocks' | 'related' {
  const type = args.link_type ?? 'blocks';
  if (type !== 'blocks' && type !== 'related') throw refuse('link_type must be "blocks" or "related".', ['link_type']);
  return type;
}

export const linkTasks: Compiler = async (ctx, args) => {
  const from = str(args, 'from_task_id'), to = str(args, 'to_task_id'), type = linkType(args);
  if (from === to) throw refuse('A task cannot be linked to itself.', ['to_task_id']);
  const [fromTask, toTask] = [await ctx.read('task', from), await ctx.read('task', to)];
  for (const [id, snapshot] of [[from, fromTask], [to, toTask]] as const) if (snapshot.row === null) throw notFound(`task not found: ${id}`);
  const fromTitle = fromTask.row!.title as string, toTitle = toTask.row!.title as string;
  const log: ToolLogDraft = { tool_name: 'link_tasks', task_id: null, title: `${fromTitle} → ${toTitle}`, detail: type };
  const response = { linked: true, from_task_id: from, from_task_title: fromTitle, to_task_id: to, to_task_title: toTitle, link_type: type, action_log_entry: entry(log) };

  // A related link is symmetric and stored with ascending endpoints. One that already exists in
  // either orientation counts as present (parity finding 3).
  const [lo, hi] = type === 'related' && from > to ? [to, from] : [from, to];
  const present = await ctx.readLink(lo, hi, type);
  const reverse = type === 'related' ? await ctx.readLink(hi, lo, type) : null;
  const existing = [present, reverse].filter(link => link !== null && link.row !== null);
  if (existing.length > 0) {
    return { kind: 'noop', response, log, guards: [
      ...existing.map(link => ({ kind: 'entity.revision' as const, key: link!.key as never, expected: link!.version!.revision as never })),
      { kind: 'workspace.structural_revision', expected: ctx.structural as never },
    ] };
  }
  return { kind: 'commands', commands: [{ kind: 'link.add', from: lo, to: hi, linkType: type, expectedRevision: present.version?.revision ?? null, expectedStructuralRevision: ctx.structural }],
    respond: () => ({ response, log }) };
};

export const unlinkTasks: Compiler = async (ctx, args) => {
  const from = str(args, 'from_task_id'), to = str(args, 'to_task_id'), type = linkType(args);
  const log: ToolLogDraft = { tool_name: 'unlink_tasks', task_id: null, title: 'Unlinked', detail: `${from} → ${to}` };
  const response = { unlinked: true, from_task_id: from, to_task_id: to, action_log_entry: entry(log) };
  // The exact stored orientation is removed; anything else is already absent.
  const link = await ctx.readLink(from, to, type);
  if (link.row === null) {
    return { kind: 'noop', response, log, guards: [
      { kind: 'entity.revision', key: link.key as never, expected: (link.version?.revision ?? null) as never },
      { kind: 'workspace.structural_revision', expected: ctx.structural as never },
    ] };
  }
  return { kind: 'commands', commands: [{ kind: 'link.remove', from, to, linkType: type, expectedRevision: ctx.expectedRevision ?? link.version!.revision, expectedStructuralRevision: ctx.structural }],
    respond: () => ({ response, log }) };
};
