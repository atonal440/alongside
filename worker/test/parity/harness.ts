/**
 * Parity harness for docs/plans/mcp-surface.md "Adapter parity".
 *
 * A row names an MCP tool and an input. `runRow` builds a fixed fixture workspace, calls the tool
 * through the real MCP handler under a fixed clock, and returns a normalized outcome: the
 * response (or error) plus a diff of the user-visible tables. The outcome of the legacy handlers
 * is pinned in `legacy-outcomes.json`; after phase C an adapter must reproduce it exactly unless
 * the row appears in `approvedDifferences` with a reason.
 */
import { vi } from 'vitest';
import { DB } from '../../src/db';
import { handleMcpRequest } from '../../src/mcp';
import { sqliteD1 } from '../helpers/sqliteD1';

export const FIXTURE_CLOCK = '2026-10-01T09:00:00.000Z';
export const CALL_CLOCK = '2026-10-03T12:00:00.000Z';

export interface Row {
  id: string;
  tool: string;
  /** Strings of the form "$alias" are replaced with fixture IDs. */
  input: Record<string, unknown>;
  /** What the row exercises, in one line. */
  note: string;
}
export type Aliases = Record<string, string>;
export interface Outcome {
  result: { ok: true; response: unknown } | { ok: false; channel: 'rpc_error' | 'tool_error'; message: string; code?: string };
  diff: Record<string, unknown>;
}

const TABLES: Record<string, { sql: string; key: (row: Record<string, unknown>) => string }> = {
  tasks: { sql: 'SELECT * FROM tasks', key: row => String(row.id) },
  projects: { sql: 'SELECT * FROM projects', key: row => String(row.id) },
  task_links: { sql: 'SELECT * FROM task_links', key: row => `${row.from_task_id}>${row.to_task_id}:${row.link_type}` },
  action_log: { sql: 'SELECT * FROM action_log', key: row => String(row.id) },
  user_preferences: { sql: 'SELECT * FROM user_preferences', key: row => String(row.key) },
};

type Snapshot = Record<string, Map<string, Record<string, unknown>>>;

/** The fixture world every row starts from. */
export async function buildFixture(db: DB): Promise<Aliases> {
  const a: Aliases = {};
  const add = async (alias: string, input: Parameters<DB['addTask']>[0]) => { a[alias] = (await db.addTask(input)).id; };
  await add('pend', { title: 'Pending' });
  await add('pend2', { title: 'Second pending' });
  await add('notes', { title: 'Has fields', notes: 'old notes', kickoff_note: 'old kickoff' });
  await add('plan', { title: 'Plan task', task_type: 'plan' });
  await add('dueonly', { title: 'Due only', due_date: '2026-10-10' });
  await add('timed', { title: 'Timed', due_date: '2026-10-10T15:00:00Z' });
  await add('weekly', { title: 'Weekly', due_date: '2026-10-05', recurrence: 'FREQ=WEEKLY' });
  await add('todone', { title: 'To be done' });
  await add('todefer', { title: 'To be deferred' });
  await add('tosomeday', { title: 'To be someday' });
  await add('tofocus', { title: 'To be focused' });
  await add('blocker', { title: 'Blocker' });
  await add('blocked', { title: 'Blocked' });
  await add('rel1', { title: 'Related one' });
  await add('rel2', { title: 'Related two' });
  const project = await db.createProject({ title: 'Fixture project', notes: 'p notes', kickoff_note: 'p kickoff' });
  a.proj = project.id;
  await add('member', { title: 'Member', project_id: project.id });
  a.archived = (await db.createProject({ title: 'Archived project' })).id;
  await db.updateProject(a.archived, { status: 'archived' });
  await db.completeTask(a.todone!);
  await db.deferTask(a.todefer!, 'until', '2026-12-01T09:00:00Z');
  await db.deferTask(a.tosomeday!, 'someday');
  await db.focusTask(a.tofocus!, '2026-10-03T15:00:00Z');
  await db.linkTasks(a.blocker!, a.blocked!, 'blocks');
  await db.linkTasks(a.rel1!, a.rel2!, 'related');
  await db.setPreference('planning_prompt', 'never');
  // Stable aliases for the states the rows talk about.
  a.done = a.todone!; a.deferred = a.todefer!; a.someday = a.tosomeday!; a.focused = a.tofocus!;
  a.none = 't_nonex1'; a.noneProject = 'p_nonex1';
  return a;
}

function substitute(value: unknown, aliases: Aliases): unknown {
  if (typeof value === 'string' && value.startsWith('$')) {
    const id = aliases[value.slice(1)];
    if (id === undefined) throw new Error(`Unknown alias ${value}`);
    return id;
  }
  if (Array.isArray(value)) return value.map(item => substitute(item, aliases));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, aliases)]));
  return value;
}

function snapshot(sql: ReturnType<typeof sqliteD1>['sql']): Snapshot {
  return Object.fromEntries(Object.entries(TABLES).map(([name, table]) => [
    name, new Map((sql.prepare(table.sql).all() as Record<string, unknown>[]).map(row => [table.key(row), { ...row }])),
  ]));
}

function diff(before: Snapshot, after: Snapshot): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(TABLES)) {
    const added: unknown[] = [], removed: unknown[] = [], changed: unknown[] = [];
    for (const [key, row] of after[name]!) {
      const prior = before[name]!.get(key);
      if (!prior) { added.push({ key, ...row }); continue; }
      const fields = Object.fromEntries(Object.keys(row).filter(f => prior[f] !== row[f]).map(f => [f, [prior[f], row[f]]]));
      if (Object.keys(fields).length) changed.push({ key, fields });
    }
    for (const [key, row] of before[name]!) if (!after[name]!.has(key)) removed.push({ key, ...row });
    if (added.length || removed.length || changed.length) out[name] = { ...(added.length ? { added } : {}), ...(removed.length ? { removed } : {}), ...(changed.length ? { changed } : {}) };
  }
  return out;
}

/** Replace fixture IDs by alias and every other minted ID by $newN, in order of appearance. */
function normalize(value: unknown, aliases: Aliases): unknown {
  const byId = new Map(Object.entries(aliases).map(([alias, id]) => [id, alias]));
  const minted = new Map<string, string>();
  let text = JSON.stringify(value);
  text = text.replace(/(?<![0-9A-Za-z_-])[tp]_[0-9A-Za-z_-]{5}(?![0-9A-Za-z_-])/g, id => {
    const alias = byId.get(id);
    if (alias) return `$${alias}`;
    if (!minted.has(id)) minted.set(id, `$new${minted.size + 1}`);
    return minted.get(id)!;
  });
  text = text.replaceAll(CALL_CLOCK, '<now>');
  return JSON.parse(text);
}

export async function runRow(row: Row): Promise<Outcome> {
  const { sql, d1 } = sqliteD1();
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    const db = new DB(d1);
    vi.setSystemTime(new Date(FIXTURE_CLOCK));
    const aliases = await buildFixture(db);
    vi.setSystemTime(new Date(CALL_CLOCK));
    const before = snapshot(sql);
    const request = new Request('https://parity.test/mcp', { method: 'POST', body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: row.tool, arguments: substitute(row.input, aliases) },
    }) });
    const body = await (await handleMcpRequest(request, db, { DB: d1, AUTH_TOKEN: 'test' })).json() as {
      result?: { isError?: boolean; content: { text: string }[]; structuredContent?: unknown }; error?: { message: string } };
    let result: Outcome['result'];
    if (body.error) result = { ok: false, channel: 'rpc_error', message: body.error.message };
    else if (body.result?.isError) {
      const detail = (body.result.structuredContent as { error?: { code?: string } } | undefined)?.error;
      result = { ok: false, channel: 'tool_error', message: body.result.content[0]!.text, ...(detail?.code ? { code: detail.code } : {}) };
    } else result = { ok: true, response: body.result?.structuredContent };
    const outcome: Outcome = { result, diff: diff(before, snapshot(sql)) };
    return normalize(outcome, aliases) as Outcome;
  } finally { vi.useRealTimers(); sql.close(); }
}
