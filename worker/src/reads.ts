/**
 * Phase B read tools: `find`, `get_context`, `get_history` and `describe_commands`.
 * They replace the list/get read tools (which stay as deprecated aliases) and never write.
 * See docs/plans/mcp-surface.md.
 */
import { parseEntityReadKey, parseLinkKey } from '@shared/wire/versions';
import { CommandError } from './domain/commands';
import { invalidInput } from './domain/temporalFoundation';
import { COMMAND_ENVELOPE_PROPERTIES, COMMAND_VARIANTS } from './commands';
import type { DB } from './db';
import { readinessScore } from '@shared/readiness';
import type { Task } from '@shared/types';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export const READ_TOOLS = [
  {
    name: 'find',
    description: 'Search tasks or projects. entity "task" filters by statuses (default ["pending"], deferred tasks included), text (case-insensitive over title and notes) and project_id; preset "ready" returns unblocked, non-deferred pending tasks by readiness score. entity "project" filters by status (default "active"). Results are deterministic and page with nextCursor. Replaces list_tasks, get_ready_tasks and list_projects.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        entity: { enum: ['task', 'project'] },
        preset: { enum: ['ready'], description: 'Task only. Mutually exclusive with statuses.' },
        filter: {
          type: 'object', additionalProperties: false,
          properties: {
            statuses: { type: 'array', items: { enum: ['pending', 'done'] }, description: 'Task only. Defaults to ["pending"].' },
            text: { type: 'string', description: 'Task only. Matches title and notes.' },
            project_id: { type: 'string', description: 'Task only. Restrict to one project.' },
            status: { enum: ['active', 'archived'], description: 'Project only. Defaults to "active".' },
          },
        },
        limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: `Defaults to ${DEFAULT_LIMIT}.` },
        cursor: { type: 'string', description: 'The nextCursor from the previous page.' },
      },
      required: ['entity'],
    },
  },
  {
    name: 'get_context',
    description: 'Read one entity. depth 0 returns exactly what get_entity / get_link / get_planning_settings return: the row plus entity and structural revisions. The default depth 1 adds the neighborhood for a task (project, prerequisites, dependents, related tasks) or a project (ready tasks, task counts); links and settings have no neighborhood. Replaces get_entity, get_link, get_planning_settings and get_project_context.',
    inputSchema: {
      type: 'object',
      oneOf: [
        ...['task', 'project'].map(entity => ({ type: 'object', additionalProperties: false, properties: { entity: { const: entity }, id: { type: 'string' }, depth: { enum: [0, 1] } }, required: ['entity', 'id'] })),
        { type: 'object', additionalProperties: false, properties: { entity: { const: 'link' }, from: { type: 'string' }, to: { type: 'string' }, linkType: { enum: ['blocks', 'related'] }, depth: { enum: [0, 1] } }, required: ['entity', 'from', 'to', 'linkType'] },
        { type: 'object', additionalProperties: false, properties: { entity: { const: 'settings' }, depth: { enum: [0, 1] } }, required: ['entity'] },
      ],
    },
  },
  {
    name: 'get_history',
    description: 'Recent changes, newest first: action-log entries (what the assistant and the app did, with titles) merged with the command audit (actor, reason and diffs of reliable commands). Each entry has source "action_log" or "command". Replaces get_action_log.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { limit: { type: 'integer', minimum: 1, maximum: MAX_LIMIT, description: `Per source. Defaults to ${DEFAULT_LIMIT}.` } },
    },
  },
  {
    name: 'describe_commands',
    description: 'Schema, an example and the error codes for one command family accepted by preview_changes / apply_changes. Call it before building a command you have not used. Families: task, project, link, planning, preference.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { family: { enum: ['task', 'project', 'link', 'planning', 'preference'] } },
      required: ['family'],
    },
  },
] as const;

export const READ_TOOL_NAMES: readonly string[] = READ_TOOLS.map(tool => tool.name);

const bad = (path: string[], message: string) => new CommandError(invalidInput([{ code: 'invalid_input', path, message }]), 400);

function object(args: unknown): Record<string, unknown> {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) throw bad([], 'Expected an input object.');
  return args as Record<string, unknown>;
}
function only(args: Record<string, unknown>, allowed: string[], path: string[] = []): void {
  for (const key of Object.keys(args)) if (!allowed.includes(key)) throw bad([...path, key], `Unknown key "${key}".`);
}
function limitOf(value: unknown): number {
  if (value === undefined) return DEFAULT_LIMIT;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_LIMIT) throw bad(['limit'], `limit must be an integer from 1 to ${MAX_LIMIT}.`);
  return value;
}

type SortKey = (string | number)[];

function compareKeys(a: SortKey, b: SortKey): number {
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!; const y = b[i]!;
    const order = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
    if (order !== 0) return order;
  }
  return 0;
}

function decodeCursor(cursor: string): SortKey {
  try {
    const key: unknown = JSON.parse(atob(cursor.replace(/-/g, '+').replace(/_/g, '/')));
    if (Array.isArray(key) && key.length > 0 && key.every(part => typeof part === 'string' || typeof part === 'number')) return key as SortKey;
  } catch { /* fall through to the error below */ }
  throw bad(['cursor'], 'cursor is not a nextCursor from a previous page; repeat the search without a cursor.');
}

/**
 * Keyset paging over a list already sorted ascending by `keyOf`. The cursor is the sort key of the
 * last item returned, so the next page is whatever sorts after that key even if the item itself was
 * completed, deleted or edited between pages.
 */
function page<T>(items: T[], limit: number, cursor: unknown, keyOf: (item: T) => SortKey): { items: T[]; nextCursor: string | null } {
  let start = 0;
  if (cursor !== undefined) {
    if (typeof cursor !== 'string') throw bad(['cursor'], 'cursor must be a string.');
    const after = decodeCursor(cursor);
    const shape = items.length > 0 ? keyOf(items[0]!) : after;
    if (after.length !== shape.length || after.some((part, i) => typeof part !== typeof shape[i])) throw bad(['cursor'], 'cursor does not belong to this search; repeat the search without a cursor.');
    start = items.findIndex(item => compareKeys(keyOf(item), after) > 0);
    if (start < 0) start = items.length;
  }
  const slice = items.slice(start, start + limit);
  const last = slice[slice.length - 1];
  const nextCursor = last !== undefined && start + limit < items.length
    ? btoa(JSON.stringify(keyOf(last))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
    : null;
  return { items: slice, nextCursor };
}

async function find(args: Record<string, unknown>, db: DB) {
  only(args, ['entity', 'preset', 'filter', 'limit', 'cursor']);
  const limit = limitOf(args.limit);
  const filter = args.filter === undefined ? {} : object(args.filter);
  only(filter, ['statuses', 'text', 'project_id', 'status'], ['filter']);
  if (args.entity === 'project') {
    if (args.preset !== undefined) throw bad(['preset'], 'Projects have no presets.');
    for (const key of ['statuses', 'text', 'project_id']) if (key in filter) throw bad(['filter', key], `${key} applies to tasks only.`);
    const status = filter.status ?? 'active';
    if (status !== 'active' && status !== 'archived') throw bad(['filter', 'status'], 'status must be "active" or "archived".');
    const projects = (await db.listProjects(status)).slice().sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    return { entity: 'project', ...(({ items, nextCursor }) => ({ items, nextCursor }))(page(projects, limit, args.cursor, project => [project.created_at, project.id])) };
  }
  if (args.entity !== 'task') throw bad(['entity'], 'entity must be "task" or "project".');
  if ('status' in filter) throw bad(['filter', 'status'], 'status applies to projects only; use statuses for tasks.');
  const projectId = filter.project_id;
  if (projectId !== undefined && typeof projectId !== 'string') throw bad(['filter', 'project_id'], 'project_id must be a string.');
  const text = filter.text;
  if (text !== undefined && typeof text !== 'string') throw bad(['filter', 'text'], 'text must be a string.');
  let tasks: Task[];
  let keyOf: (task: Task) => SortKey = task => [task.due_date ?? '', task.created_at, task.id];
  if (args.preset !== undefined) {
    if (args.preset !== 'ready') throw bad(['preset'], 'preset must be "ready".');
    if ('statuses' in filter) throw bad(['filter', 'statuses'], 'The ready preset is pending-only; omit statuses.');
    tasks = await db.listReadyTasks(projectId);
    // Re-sort with one timestamp so the order and the cursor keys agree exactly. Scores drift with
    // edits and the clock, so a page boundary can still shift slightly between calls, but a cursor
    // never errors and never loops.
    const at = new Date().toISOString();
    keyOf = task => [-readinessScore(task, at), task.created_at, task.id];
    tasks = tasks.slice().sort((a, b) => compareKeys(keyOf(a), keyOf(b)));
  } else {
    const statuses = filter.statuses ?? ['pending'];
    if (!Array.isArray(statuses) || statuses.length === 0 || statuses.some(status => status !== 'pending' && status !== 'done')) throw bad(['filter', 'statuses'], 'statuses must be a non-empty list of "pending" or "done".');
    tasks = (await db.listAllTasks(statuses as Task['status'][])).slice()
      .sort((a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? '') || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    if (projectId !== undefined) tasks = tasks.filter(task => task.project_id === projectId);
  }
  if (text) {
    const q = text.toLowerCase();
    tasks = tasks.filter(task => task.title.toLowerCase().includes(q) || (task.notes?.toLowerCase().includes(q) ?? false));
  }
  const { items, nextCursor } = page(tasks, limit, args.cursor, keyOf);
  return { entity: 'task', items, nextCursor };
}

async function getContext(args: Record<string, unknown>, db: DB) {
  const depth = args.depth === undefined ? 1 : args.depth;
  if (depth !== 0 && depth !== 1) throw bad(['depth'], 'depth must be 0 or 1.');
  const { depth: _depth, ...rest } = args;
  if (rest.entity === 'settings') {
    only(rest, ['entity']);
    return { contractVersion: 2, settings: await db.getPlanningSettings() };
  }
  if (rest.entity === 'link') {
    const key = parseLinkKey(rest);
    if (!key.ok) throw new CommandError(invalidInput(key.error), 400);
    return db.getLinkSnapshot(key.value);
  }
  const key = parseEntityReadKey(rest);
  if (!key.ok) throw new CommandError(invalidInput(key.error), 400);
  const snapshot = await db.getEntitySnapshot(key.value);
  if (depth === 0 || snapshot.row === null) return snapshot;
  if (snapshot.entity === 'project') {
    const [ready, pending, done] = await Promise.all([db.listReadyTasks(snapshot.id), db.listAllTasks(['pending']), db.listAllTasks(['done'])]);
    const count = (tasks: Task[]) => tasks.filter(task => task.project_id === snapshot.id).length;
    return { ...snapshot, context: { ready_tasks: ready, task_counts: { pending: count(pending), done: count(done) } } };
  }
  const links = await db.getTaskLinks(snapshot.id);
  const ids = new Set(links.flatMap(link => [link.from_task_id, link.to_task_id]));
  ids.delete(snapshot.id);
  const related = new Map((await Promise.all([...ids].map(id => db.getTask(id)))).flatMap(task => task ? [[task.id, task] as const] : []));
  const pick = (predicate: (link: (typeof links)[number]) => boolean, other: 'from_task_id' | 'to_task_id') =>
    links.filter(predicate).flatMap(link => { const task = related.get(link[other]); return task ? [task] : []; });
  const project = snapshot.row.project_id ? await db.getProject(snapshot.row.project_id) : null;
  return { ...snapshot, context: {
    project,
    prerequisites: pick(link => link.link_type === 'blocks' && link.to_task_id === snapshot.id, 'from_task_id'),
    dependents: pick(link => link.link_type === 'blocks' && link.from_task_id === snapshot.id, 'to_task_id'),
    related: links.filter(link => link.link_type === 'related').flatMap(link => { const task = related.get(link.from_task_id === snapshot.id ? link.to_task_id : link.from_task_id); return task ? [task] : []; }),
  } };
}

async function getHistory(args: Record<string, unknown>, db: DB) {
  only(args, ['limit']);
  const limit = limitOf(args.limit);
  const [actions, audit] = await Promise.all([db.getActionLog(limit), db.listCommandAudit(limit)]);
  const entries = [
    ...actions.map(entry => ({ source: 'action_log' as const, at: entry.created_at, ...entry })),
    ...audit.map(row => ({ source: 'command' as const, at: row.created_at, command_id: row.command_id, actor: row.actor, reason: row.reason, changes: JSON.parse(row.changes_json) as unknown })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  return { entries };
}

const EXAMPLES: Record<string, unknown> = {
  task: { contractVersion: 2, commandId: 'c_example01', actor: 'llm', commands: [{ kind: 'task.focus.set', id: 't_example1', expectedRevision: 3, focusedUntil: '2026-10-03T18:00:00Z' }] },
  project: { contractVersion: 2, commandId: 'c_example02', actor: 'llm', commands: [{ kind: 'project.archive', id: 'p_example1', expectedRevision: 2 }] },
  link: { contractVersion: 2, commandId: 'c_example03', actor: 'llm', commands: [{ kind: 'link.add', from: 't_example1', to: 't_example2', linkType: 'blocks', expectedRevision: null, expectedStructuralRevision: 7 }] },
  preference: { contractVersion: 2, commandId: 'c_example05', actor: 'user', commands: [{ kind: 'preference.set', key: 'sort_by', value: 'due', expectedRevision: null }] },
  planning: { contractVersion: 2, commandId: 'c_example04', actor: 'user', commands: [{ kind: 'planning.set', expectedRevision: null, values: { timezone: 'America/Chicago', bufferMinutes: 10, workingHours: [{ weekday: 1, start: '09:00', end: '17:00' }] } }] },
};
const FAMILY_ERRORS = {
  common: ['invalid_input', 'unknown_key', 'revision_conflict', 'structural_conflict', 'command_id_conflict', 'capacity_exceeded', 'storage_unavailable'],
  task: ['invalid_state', 'invalid_transition', 'missing_date', 'revision_exhausted'],
  project: ['invalid_state', 'invalid_transition'],
  link: ['graph_cycle', 'invalid_state', 'already_applied'],
  planning: ['revision_conflict'],
  preference: ['revision_conflict', 'revision_exhausted'],
} as const;

function describeCommands(args: Record<string, unknown>) {
  only(args, ['family']);
  const family = args.family;
  if (typeof family !== 'string' || !(family in EXAMPLES)) throw bad(['family'], 'family must be one of task, project, link, planning, preference.');
  return {
    contractVersion: 2,
    family,
    envelope: { description: 'Shared by preview_changes and apply_changes. Standalone commands carry their own guards; 2–20 commands need expectedStructuralRevision.', properties: COMMAND_ENVELOPE_PROPERTIES },
    commands: COMMAND_VARIANTS.filter(variant => variant.properties.kind.const.startsWith(`${family}.`)),
    example: EXAMPLES[family],
    errorCodes: [...FAMILY_ERRORS.common, ...FAMILY_ERRORS[family as keyof typeof FAMILY_ERRORS]],
  };
}

export async function callReadTool(name: string, args: unknown, db: DB): Promise<unknown> {
  const input = object(args);
  switch (name) {
    case 'find': return find(input, db);
    case 'get_context': return getContext(input, db);
    case 'get_history': return getHistory(input, db);
    case 'describe_commands': return describeCommands(input);
    default: throw new Error(`Unknown read tool: ${name}`);
  }
}
