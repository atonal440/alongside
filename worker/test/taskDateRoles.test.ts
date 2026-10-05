import { describe, expect, it } from 'vitest';
import { DB } from '../src/db';
import { callCommandTool } from '../src/commands';
import { handleMcpRequest } from '../src/mcp';
import { callReadTool } from '../src/reads';
import { sqliteD1 } from './helpers/sqliteD1';
import { parseCommandEnvelope, parseChangesResult } from '@shared/wire/commands';
import { parseWorkspaceRestoreInput } from '@shared/wire/workspaceRestore';
import { parseEntityReadKey } from '@shared/wire/versions';
import { isAvailable, readinessScore } from '@shared/readiness';

const LA = 'America/Los_Angeles';
const base = { intent: true, contractVersion: 2 };
const preview = (db: DB, args: unknown) => callCommandTool('preview_changes', args, db) as Promise<any>;
const apply = (db: DB, args: unknown) => callCommandTool('apply_changes', args, db) as Promise<any>;
const taskKey = (id: string) => { const parsed = parseEntityReadKey({ entity: 'task', id }); if (!parsed.ok) throw new Error('bad key'); return parsed.value; };

async function tool(db: DB, d1: D1Database, name: string, args: unknown) {
  const request = new Request('https://t/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  return (await (await handleMcpRequest(request, db, { DB: d1, AUTH_TOKEN: 't' }, 'default')).json()) as { result?: any; error?: any };
}
async function setTimezone(db: DB) {
  const envelope = parseCommandEnvelope({ contractVersion: 2, commandId: 'c_planning1', actor: 'user', commands: [{ kind: 'planning.set', expectedRevision: null, values: { timezone: LA, bufferMinutes: 0, workingHours: [] } }] });
  if (!envelope.ok) throw new Error(JSON.stringify(envelope.error));
  await db.applyChanges(envelope.value);
}
const dates = (id: string, revision: number, values: object, commandId = 'c_dates001') => {
  const parsed = parseCommandEnvelope({ contractVersion: 2, commandId, actor: 'user', commands: [{ kind: 'task.dates.set', id, expectedRevision: revision, values }] });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
  return parsed.value;
};
const day = (date: string, timezone = LA) => ({ kind: 'date', date, timezone });

describe.each(['fresh', 'upgrade'] as const)('task.dates.set (%s)', mode => {
  it('sets and clears availability and deadline without touching the target or other fields', async () => {
    const { sql, d1 } = sqliteD1(mode); const db = new DB(d1);
    try {
      const task = await db.addTask({ title: 'Apply', notes: 'n', due_date: '2026-10-05' });
      const planned = await db.previewChanges(dates(task.id, 1, { availableFrom: day('2026-10-06'), deadline: null }, 'c_dates0pv'));
      expect(planned.requiredStatements).toBe(6);   // documented in reliable-task-fields.md
      const result = await db.applyChanges(dates(task.id, 1, { availableFrom: day('2026-10-06'), deadline: { kind: 'instant', at: '2026-10-09T17:00:00-07:00', timezone: LA } }));
      expect(parseChangesResult(result).ok).toBe(true);
      const row = (await db.getTask(task.id))!;
      expect(row).toMatchObject({ due_date: task.due_date, due_all_day: task.due_all_day, notes: 'n', status: 'pending' });
      expect(row.available_from).toBe('{"kind":"date","date":"2026-10-06","timezone":"America/Los_Angeles"}');
      expect(row.deadline).toBe('{"kind":"instant","at":"2026-10-10T00:00:00Z","timezone":"America/Los_Angeles"}');
      expect(JSON.parse(sql.prepare("SELECT row_json FROM sync_feed WHERE entity='task' AND entity_key=? ORDER BY seq DESC").get(task.id)!['row_json'] as string)).toMatchObject({ deadline: row.deadline, available_from: row.available_from });
      await db.applyChanges(dates(task.id, 2, { availableFrom: null, deadline: null }, 'c_dates002'));
      expect(await db.getTask(task.id)).toMatchObject({ available_from: null, deadline: null, due_date: task.due_date });
    } finally { sql.close(); }
  });

  it('rejects a window that never opens and a date the zone skipped', async () => {
    const { sql, d1 } = sqliteD1(mode); const db = new DB(d1);
    try {
      const task = await db.addTask({ title: 'Window' });
      await expect(db.applyChanges(dates(task.id, 1, { availableFrom: day('2026-10-10'), deadline: day('2026-10-08') }))).rejects.toMatchObject({ detail: { code: 'invalid_input', path: ['commands', '0', 'values', 'availableFrom'] } });
      // A deadline instant equal to the opening instant leaves no window either.
      await expect(db.applyChanges(dates(task.id, 1, { availableFrom: { kind: 'instant', at: '2026-10-10T09:00:00Z', timezone: 'UTC' }, deadline: { kind: 'instant', at: '2026-10-10T09:00:00Z', timezone: 'UTC' } }, 'c_dates003'))).rejects.toMatchObject({ detail: { code: 'invalid_input' } });
      // Pacific/Apia skipped 2011-12-30 entirely, so that local date has no boundary.
      await expect(db.applyChanges(dates(task.id, 1, { availableFrom: null, deadline: day('2011-12-30', 'Pacific/Apia') }, 'c_dates004'))).rejects.toMatchObject({ detail: { code: 'invalid_input', path: ['commands', '0', 'values', 'deadline'] } });
      expect(await db.getTask(task.id)).toMatchObject({ available_from: null, deadline: null });
    } finally { sql.close(); }
  });
});

it('refuses unreadable stored points at the table boundary', async () => {
  const { sql, d1 } = sqliteD1(); const db = new DB(d1);
  try {
    const task = await db.addTask({ title: 'Bad' });
    expect(() => sql.prepare('UPDATE tasks SET deadline=? WHERE id=?').run('not json', task.id)).toThrow();
    expect(() => sql.prepare('UPDATE tasks SET available_from=? WHERE id=?').run('[1]', task.id)).toThrow();
  } finally { sql.close(); }
});

it('rejects a task row whose date role is not canonical TemporalPoint JSON', async () => {
  const { sql, d1 } = sqliteD1(); const db = new DB(d1);
  try {
    const task = await db.addTask({ title: 'Loose' });
    sql.prepare('UPDATE tasks SET deadline=? WHERE id=?').run('{"kind":"date","timezone":"UTC","date":"2026-10-09"}', task.id);
    await expect(db.getEntitySnapshot(taskKey(task.id))).rejects.toThrow();
  } finally { sql.close(); }
});

describe('loose intent and quick verbs', () => {
  it('merges a one-role patch into the stored points', async () => {
    const { sql, d1 } = sqliteD1(); const db = new DB(d1);
    try {
      const task = await db.addTask({ title: 'Merge' });
      await db.applyChanges(dates(task.id, 1, { availableFrom: day('2026-10-06'), deadline: day('2026-10-09') }));
      const result = await preview(db, { ...base, commands: [{ kind: 'task.dates.set', id: task.id, values: { deadline: day('2026-10-12') } }] });
      expect(result.pinnedEnvelope.commands[0].values).toEqual({ availableFrom: day('2026-10-06'), deadline: day('2026-10-12') });
      await apply(db, result.pinnedEnvelope);
      expect(JSON.parse((await db.getTask(task.id))!.deadline!)).toEqual(day('2026-10-12'));
    } finally { sql.close(); }
  });

  it('creates a task and its deadline in one preview through a client reference', async () => {
    const { sql, d1 } = sqliteD1(); const db = new DB(d1);
    try {
      const result = await preview(db, { ...base, commands: [
        { kind: 'task.create', clientRef: 'a', values: { title: 'New with deadline' } },
        { kind: 'task.dates.set', id: '@a', values: { deadline: day('2026-10-09') } },
        { kind: 'task.dates.set', id: '@a', values: { availableFrom: day('2026-10-07') } },
      ] });
      const applied = await apply(db, result.pinnedEnvelope);
      expect(JSON.parse((await db.getTask(applied.refs.a))!.deadline!)).toEqual(day('2026-10-09'));
      expect(JSON.parse((await db.getTask(applied.refs.a))!.available_from!)).toEqual(day('2026-10-07'));
    } finally { sql.close(); }
  });

  it('add_task and update_task take dates with an explicit or workspace timezone and show points as objects', async () => {
    const { sql, d1 } = sqliteD1(); const db = new DB(d1);
    try {
      const refused = await tool(db, d1, 'add_task', { title: 'No zone', deadline: '2026-10-09' });
      expect(refused.result?.isError).toBe(true);
      expect(JSON.stringify(refused)).toMatch(/needs a time zone/);
      const explicit = await tool(db, d1, 'add_task', { title: 'Zoned', deadline: '2026-10-09', available_from: '2026-10-06T09:00:00-07:00', timezone: 'Europe/Paris' });
      expect(explicit.result.structuredContent).toMatchObject({ deadline: day('2026-10-09', 'Europe/Paris'), available_from: { kind: 'instant', at: '2026-10-06T16:00:00Z', timezone: 'Europe/Paris' } });
      await setTimezone(db);
      const defaulted = await tool(db, d1, 'add_task', { title: 'Defaulted', deadline: '2026-10-09', due_date: '2026-10-08' });
      const id = defaulted.result.structuredContent.id as string;
      expect(defaulted.result.structuredContent).toMatchObject({ deadline: day('2026-10-09'), due_date: '2026-10-08T12:00:00Z' });
      const moved = await tool(db, d1, 'update_task', { task_id: id, deadline: '2026-10-11' });
      expect(moved.result.structuredContent).toMatchObject({ deadline: day('2026-10-11'), due_date: '2026-10-08T12:00:00Z' });
      const cleared = await tool(db, d1, 'update_task', { task_id: id, deadline: null, title: 'Renamed' });
      expect(cleared.result.structuredContent).toMatchObject({ deadline: null, title: 'Renamed' });
      expect(JSON.stringify(await tool(db, d1, 'update_task', { task_id: id, deadline: 'friday' }))).toMatch(/not a valid date|invalid/i);
    } finally { sql.close(); }
  });

  it('keeps the stored spelling in portable exports', async () => {
    const { sql, d1 } = sqliteD1(); const db = new DB(d1);
    try {
      const task = await db.addTask({ title: 'Export' });
      await db.applyChanges(dates(task.id, 1, { availableFrom: null, deadline: day('2026-10-09') }));
      const exported = await db.exportWorkspace();
      expect(exported.tasks.find(row => row.id === task.id)!.deadline).toBe('{"kind":"date","date":"2026-10-09","timezone":"America/Los_Angeles"}');
    } finally { sql.close(); }
  });
});

describe('readiness', () => {
  it('holds a task back until available_from and ranks hard deadlines above plain targets', async () => {
    const { sql, d1 } = sqliteD1(); const db = new DB(d1);
    try {
      const soon = await db.addTask({ title: 'Opens later' });
      const open = await db.addTask({ title: 'Open now' });
      await db.applyChanges(dates(soon.id, 1, { availableFrom: day('2999-01-01', 'UTC'), deadline: null }));
      const ready = (await db.listReadyTasks()).map(task => task.title);
      expect(ready).toContain('Open now');
      expect(ready).not.toContain('Opens later');
      const row = (await db.getTask(soon.id))!;
      expect(isAvailable(row, '2998-12-31T23:59:00Z')).toBe(false);
      expect(isAvailable(row, '2999-01-01T00:00:00Z')).toBe(true);
      expect(readinessScore(row, new Date().toISOString())).toBe(5);
      const now = '2026-10-05T12:00:00Z';
      const plain = { ...(await db.getTask(open.id))!, updated_at: '2000-01-01T00:00:00Z', created_at: '2000-01-01T00:00:00Z' };
      const targeted = { ...plain, due_date: '2026-10-05T20:00:00Z' };
      const hard = { ...plain, deadline: '{"kind":"date","date":"2026-10-05","timezone":"UTC"}' };
      expect(readinessScore(hard, now)).toBeGreaterThan(readinessScore(targeted, now));
      expect(readinessScore(targeted, now)).toBeGreaterThan(readinessScore(plain, now));
      expect(readinessScore({ ...targeted, deadline: '{"kind":"date","date":"2026-10-05","timezone":"UTC"}' }, now)).toBe(readinessScore(hard, now));
    } finally { sql.close(); }
  });

  it('sorts find by the deadline boundary with undated tasks last', async () => {
    const { sql, d1 } = sqliteD1(); const db = new DB(d1);
    try {
      const [late, soon] = await Promise.all(['late', 'soon', 'none'].map(title => db.addTask({ title })));
      await db.applyChanges(dates(late!.id, 1, { availableFrom: null, deadline: day('2026-10-20') }, 'c_dates0a1'));
      await db.applyChanges(dates(soon!.id, 1, { availableFrom: null, deadline: day('2026-10-07') }, 'c_dates0a2'));
      const asc = await callReadTool('find', { entity: 'task', sort: 'deadline' }, db) as any;
      expect(asc.items.map((task: any) => task.title)).toEqual(['soon', 'late', 'none']);
      const desc = await callReadTool('find', { entity: 'task', sort: 'deadline', order: 'desc' }, db) as any;
      expect(desc.items.map((task: any) => task.title)).toEqual(['none', 'late', 'soon']);
    } finally { sql.close(); }
  });

  it('gives a legacy recurring completion a successor without the hard dates', async () => {
    const { sql, d1 } = sqliteD1(); const db = new DB(d1);
    try {
      const task = await db.addTask({ title: 'Weekly', due_date: '2026-10-05', recurrence: 'FREQ=WEEKLY' });
      await db.applyChanges(dates(task.id, 1, { availableFrom: day('2026-10-04'), deadline: day('2026-10-08') }));
      const done = await db.completeTask(task.id);
      expect(done.next).toMatchObject({ available_from: null, deadline: null });
      expect(await db.getTask(task.id)).toMatchObject({ status: 'done', deadline: expect.any(String) });
    } finally { sql.close(); }
  });
});

describe('portable documents', () => {
  it('refuses to restore a task whose window never opens', async () => {
    const { sql, d1 } = sqliteD1(); const db = new DB(d1);
    try {
      const task = await db.addTask({ title: 'Round trip' });
      await db.applyChanges(dates(task.id, 1, { availableFrom: day('2026-10-06'), deadline: day('2026-10-09') }));
      const exported = await db.exportWorkspace();
      const cursor = sql.prepare('SELECT epoch, watermark AS sequence FROM sync_metadata').get() as { epoch: number; sequence: number };
      const make = (document: unknown) => parseWorkspaceRestoreInput({ contractVersion: 2, mode: 'apply', expectedCursor: cursor, document });
      const good = make(exported);
      expect(good.ok).toBe(true);
      const bad = make({ ...exported, tasks: exported.tasks.map(row => ({ ...row, available_from: '{"kind":"date","date":"2026-10-12","timezone":"America/Los_Angeles"}' })) });
      if (!bad.ok) throw new Error('schema should accept the document; the semantic check refuses it');
      await expect(db.restoreWorkspace(bad.value as never)).rejects.toMatchObject({ status: 400, detail: { code: 'invalid_input' } });
      if (!good.ok) throw new Error('unreachable');
      await db.restoreWorkspace(good.value as never);
      expect((await db.getTask(task.id))!.deadline).toBe(exported.tasks[0]!.deadline);
    } finally { sql.close(); }
  });
});
