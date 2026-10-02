import { describe, expect, it } from 'vitest';
import { DB } from '../src/db';
import { sqliteD1 } from './helpers/sqliteD1';
import { handleApiRequest } from '../src/api';
import { handleMcpRequest } from '../src/mcp';
import { parseWorkspaceRestoreResult } from '@shared/wire/workspaceRestore';
import { parseCommandEnvelope } from '@shared/wire/commands';
const now = '2026-10-01T10:00:00Z';

type Exported = Awaited<ReturnType<DB['exportWorkspace']>>;
const seed = `INSERT INTO projects(id,title,created_at,updated_at) VALUES('p_first1','Project','${now}','${now}');
  INSERT INTO duties(id,title,rrule,dtstart,project_id,created_at,updated_at) VALUES('d_first1','Duty','FREQ=DAILY','${now}','p_first1','${now}','${now}');
  INSERT INTO tasks(id,title,project_id,duty_id,occurrence_at,created_at,updated_at) VALUES('t_first1','First','p_first1','d_first1','${now}','${now}','${now}');
  INSERT INTO tasks(id,title,created_at,updated_at) VALUES('t_other1','Other','${now}','${now}');
  INSERT INTO task_links VALUES('t_first1','t_other1','blocks');
  INSERT INTO user_preferences VALUES('sort_by','manual');
  INSERT INTO action_log(tool_name,task_id,duty_id,title,created_at) VALUES('add_task','t_first1','d_first1','Logged','${now}');
  INSERT INTO planning_settings VALUES(1,'UTC',15,1,'${now}','${now}'); INSERT INTO planning_working_hours VALUES(1,1,'09:00','17:00');`;
const wipeOut = `DELETE FROM task_links; DELETE FROM tasks; DELETE FROM duties; DELETE FROM projects; DELETE FROM user_preferences; DELETE FROM action_log; DELETE FROM planning_settings;`;
const portable = (doc: Exported) => { const { exported_at: _t, command_audit: _a, ...rest } = doc; return rest; };
const input = (document: unknown, cursor: { epoch: number; sequence: number }, mode: 'preflight' | 'apply' = 'apply') =>
  ({ contractVersion: 2, mode, expectedCursor: cursor, document });
const cursorOf = (sql: ReturnType<typeof sqliteD1>['sql']) => { const row = sql.prepare('SELECT epoch, watermark FROM sync_metadata').get() as { epoch: number; watermark: number }; return { epoch: row.epoch, sequence: row.watermark }; };
const tables = (sql: ReturnType<typeof sqliteD1>['sql']) => Object.fromEntries(['tasks', 'projects', 'task_links', 'duties', 'user_preferences', 'action_log', 'planning_settings', 'sync_feed', 'entity_versions', 'command_receipts']
  .map(name => [name, sql.prepare(`SELECT * FROM ${name}`).all()]));

describe.each(['fresh', 'upgrade'] as const)('version 2 workspace restore (%s)', mode => {
  it('preflights without writing, then restores the exported workspace atomically in a new epoch', async () => {
    const { sql, d1, batches } = sqliteD1(mode); const db = new DB(d1);
    try {
      sql.exec(seed);
      const makeCommand = () => parseCommandEnvelope({ contractVersion: 2, commandId: 'c_restore1', actor: 'user', commands: [{ kind: 'task.create', id: 't_made01', expectedRevision: null, expectedStructuralRevision: (sql.prepare('SELECT structural_revision AS r FROM workspace_versions').get() as { r: number }).r, values: { title: 'Made', notes: null, kickoffNote: null, taskType: 'action', project: null } }] });
      const exported = await db.exportWorkspace();
      // Change the live workspace after export so restore must really replace it.
      sql.exec(`DELETE FROM task_links; UPDATE tasks SET title='Changed' WHERE id='t_other1'; INSERT INTO tasks(id,title,created_at,updated_at) VALUES('t_extra1','Extra','${now}','${now}');`);
      const command = makeCommand(); if (!command.ok) throw new Error('bad envelope');
      await db.applyChanges(command.value);
      const cursor = cursorOf(sql);
      const before = tables(sql); const batchCount = batches.length;

      const preview = await db.restoreWorkspace(input(exported, cursor, 'preflight') as never);
      expect(preview).toMatchObject({ applied: false, resultingCursor: null, previousCursor: cursor, nextEpoch: cursor.epoch + 1,
        replaces: { tasks: 4, projects: 1, links: 0, duties: 1, preferences: 1, planning_settings: 1, action_log: 1 },
        restores: { tasks: 2, projects: 1, links: 1, duties: 1, preferences: 1, planning_settings: 1, action_log: 1 }, notRestored: { command_audit: 0 }, limit: 100 });
      expect(parseWorkspaceRestoreResult(preview).ok).toBe(true);
      expect(tables(sql)).toEqual(before); expect(batches.length).toBe(batchCount);

      const result = await db.restoreWorkspace(input(exported, cursor) as never);
      expect(result).toMatchObject({ applied: true, previousCursor: cursor, resultingCursor: { epoch: cursor.epoch + 1 } });
      expect(result.resultingCursor!.sequence).toBe(cursor.sequence);
      expect(batches.length).toBe(batchCount + 1);
      const after = await db.exportWorkspace();
      expect(portable(after)).toEqual(portable(exported));
      expect(sql.prepare("SELECT revision FROM planning_settings").get()).toEqual({ revision: 2 });
      // Receipts and audit from before the restore survive; the restore advanced every old cursor.
      expect(sql.prepare("SELECT command_id FROM command_receipts").all()).toEqual([{ command_id: 'c_restore1' }]);
      expect(sql.prepare("SELECT t.duty_id FROM tasks t WHERE id='t_first1'").get()).toEqual({ duty_id: 'd_first1' });
      await expect(db.getWorkspaceDelta({ cursor }  as never)).rejects.toMatchObject({ detail: { syncReset: { reason: 'epoch_changed' } } });
      const delta = await db.getWorkspaceDelta({ cursor: result.resultingCursor! } as never);
      expect(delta.changes.length).toBeGreaterThan(0);
      // The dropped rows are tombstoned and the workspace is bootstrap-consistent.
      const snapshot = await db.getWorkspaceSnapshot();
      expect(snapshot.cursor.epoch).toEqual(result.resultingCursor!.epoch);
      expect(snapshot.entities.find(image => image.entity === 'task' && image.key === 't_extra1')).toMatchObject({ row: null });
    } finally { sql.close(); }
  });

  it('restores an empty document, clearing every family', async () => {
    const { sql, d1 } = sqliteD1(mode); const db = new DB(d1);
    try {
      sql.exec(seed);
      const empty = { version: 2, exported_at: now, tasks: [], projects: [], links: [], duties: [], preferences: [], planning_settings: null, action_log: [], command_audit: [] };
      const result = await db.restoreWorkspace(input(empty, cursorOf(sql)) as never);
      expect(result.restores.tasks).toBe(0);
      for (const name of ['tasks', 'projects', 'task_links', 'duties', 'user_preferences', 'action_log', 'planning_settings', 'planning_working_hours']) expect(sql.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get()).toEqual({ n: 0 });
    } finally { sql.close(); }
  });

  it('rejects stale cursors, concurrent writers, oversize and semantically invalid documents without changing data', async () => {
    const { sql, d1, hooks, batches } = sqliteD1(mode); const db = new DB(d1);
    try {
      sql.exec(seed);
      const exported = await db.exportWorkspace();
      const cursor = cursorOf(sql); const before = tables(sql);
      const unchanged = () => { expect(tables(sql)).toEqual(before); expect(batches).toEqual([]); };

      await expect(db.restoreWorkspace(input(exported, { ...cursor, sequence: cursor.sequence + 1 }) as never)).rejects.toMatchObject({ status: 409, detail: { code: 'restore_cursor_conflict' } });
      await expect(db.restoreWorkspace(input(exported, { ...cursor, epoch: cursor.epoch + 1 }, 'preflight') as never)).rejects.toMatchObject({ detail: { code: 'restore_cursor_conflict' } });
      unchanged();

      // A writer commits after planning but before the restore batch.
      hooks.beforeBatch = () => { sql.exec(`INSERT INTO tasks(id,title,created_at,updated_at) VALUES('t_race01','Race','${now}','${now}')`); };
      await expect(db.restoreWorkspace(input(exported, cursor) as never)).rejects.toMatchObject({ status: 409, detail: { code: 'restore_cursor_conflict' } });
      expect(sql.prepare("SELECT id FROM tasks WHERE id='t_race01'").get()).toEqual({ id: 't_race01' });
      expect(sql.prepare("SELECT epoch FROM sync_metadata").get()).toEqual({ epoch: cursor.epoch });
      expect(sql.prepare("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 3 });

      const fresh = cursorOf(sql);
      const manyTasks = Array.from({ length: 120 }, (_, index) => ({ ...exported.tasks[1]!, id: `t_many${String(index).padStart(3, '0')}`, duty_id: null, occurrence_at: null, project_id: null }));
      const oversize = { ...exported, tasks: manyTasks, links: [], action_log: [] };
      await expect(db.restoreWorkspace(input(oversize, fresh, 'preflight') as never)).rejects.toMatchObject({ status: 413, detail: { code: 'capacity_exceeded', limit: 100 } });
      await expect(db.restoreWorkspace(input(oversize, fresh) as never)).rejects.toMatchObject({ status: 413 });
      expect(sql.prepare("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 3 });

      const [first, other] = exported.tasks;
      const cycle = { ...exported, tasks: [{ ...first!, duty_id: null, occurrence_at: null }, other!], duties: [], links: [{ from_task_id: first!.id, to_task_id: other!.id, link_type: 'blocks' }, { from_task_id: other!.id, to_task_id: first!.id, link_type: 'blocks' }] };
      await expect(db.restoreWorkspace(input(cycle, fresh) as never)).rejects.toMatchObject({ status: 400, detail: { code: 'invalid_input' } });
      const half = { ...exported, tasks: [{ ...first!, occurrence_at: null }, other!] };
      await expect(db.restoreWorkspace(input(half, fresh) as never)).rejects.toMatchObject({ status: 400, detail: { code: 'invalid_input' } });
      const dup = { ...exported, tasks: [first!, { ...other!, duty_id: first!.duty_id, occurrence_at: first!.occurrence_at }] };
      await expect(db.restoreWorkspace(input(dup, fresh) as never)).rejects.toMatchObject({ status: 400, detail: { code: 'invalid_input' } });
      expect(sql.prepare("SELECT COUNT(*) AS n FROM tasks").get()).toEqual({ n: 3 });
      expect(batches).toHaveLength(1); // only the raced attempt reached storage, and it aborted
    } finally { sql.close(); }
  });

  it('rolls back a late storage failure completely, including the epoch advance', async () => {
    const { sql, d1, hooks } = sqliteD1(mode); const db = new DB(d1);
    try {
      sql.exec(seed);
      const exported = await db.exportWorkspace(); const cursor = cursorOf(sql); const before = tables(sql);
      hooks.failAfter = 10;
      await expect(db.restoreWorkspace(input(exported, cursor) as never)).rejects.toBeDefined();
      expect(tables(sql)).toEqual(before); expect(cursorOf(sql)).toEqual(cursor);
    } finally { sql.close(); }
  });
});

it('reports an uncertain outcome when the restore commits but its response is lost', async () => {
  const { sql, d1, hooks } = sqliteD1(); const db = new DB(d1);
  try {
    sql.exec(seed);
    const exported = await db.exportWorkspace(); const cursor = cursorOf(sql);
    hooks.loseResponse = true;
    await expect(db.restoreWorkspace(input(exported, cursor) as never)).rejects.toMatchObject({ status: 409, detail: { code: 'restore_outcome_unknown' } });
    expect(cursorOf(sql).epoch).toBe(cursor.epoch + 1);
  } finally { sql.close(); }
});
it('round-trips legacy related self-links but rejects blocks self-loops', async () => {
  const { sql, d1 } = sqliteD1(); const db = new DB(d1);
  try {
    sql.exec(`INSERT INTO tasks(id,title,created_at,updated_at) VALUES('t_same11','Same','${now}','${now}'); INSERT INTO task_links VALUES('t_same11','t_same11','related');`);
    const exported = await db.exportWorkspace();
    expect((await db.restoreWorkspace(input(exported, cursorOf(sql)) as never)).applied).toBe(true);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM task_links').get()).toEqual({ n: 1 });
    const loop = { ...exported, links: [{ from_task_id: 't_same11', to_task_id: 't_same11', link_type: 'blocks' }] };
    await expect(db.restoreWorkspace(input(loop, cursorOf(sql)) as never)).rejects.toMatchObject({ status: 400 });
  } finally { sql.close(); }
});
it('rejects a huge chained link graph without recursion or writes', async () => {
  const { sql, d1, batches } = sqliteD1(); const db = new DB(d1);
  try {
    const base = { id: '', title: 't', notes: null, kickoff_note: null, status: 'pending', task_type: 'action', project_id: null, due_date: null, due_all_day: null, recurrence: null,
      defer_kind: 'none', defer_until: null, focused_until: null, session_log: null, duty_id: null, occurrence_at: null, created_at: now, updated_at: now };
    const ids = Array.from({ length: 20000 }, (_, index) => `t_chain${String(index).padStart(6, '0')}`);
    const doc = { version: 2, exported_at: now, tasks: ids.map(id => ({ ...base, id })), projects: [], duties: [], preferences: [], planning_settings: null, action_log: [], command_audit: [],
      links: ids.slice(1).map((id, index) => ({ from_task_id: ids[index]!, to_task_id: id, link_type: 'blocks' })) };
    await expect(db.restoreWorkspace(input(doc, cursorOf(sql), 'preflight') as never)).rejects.toMatchObject({ status: 413, detail: { code: 'capacity_exceeded' } });
    expect(batches).toEqual([]);
  } finally { sql.close(); }
});

describe('restore transports', () => {
  it('exposes strict REST and MCP restore with identical results and no weaker input', async () => {
    const { sql, d1 } = sqliteD1(); const db = new DB(d1);
    try {
      sql.exec(seed);
      const exported = await db.exportWorkspace(); const cursor = cursorOf(sql);
      const rest = async (body: unknown) => { const request = new Request('https://x/api/v2/restore', { method: 'POST', body: JSON.stringify(body) }); return handleApiRequest(request, new URL(request.url), db); };
      const rpc = async (args: unknown) => (await (await handleMcpRequest(new Request('https://x/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'restore_workspace', arguments: args } }) }), db, { DB: d1, AUTH_TOKEN: 'tok' })).json()) as { result: { structuredContent: Record<string, unknown>; isError?: boolean } };

      const viaRest = await (await rest(input(exported, cursor, 'preflight'))).json();
      const viaMcp = (await rpc(input(exported, cursor, 'preflight'))).result.structuredContent;
      expect(viaMcp).toEqual(viaRest); expect(viaRest).toMatchObject({ applied: false });
      const [a, b] = exported.tasks;
      const cyclic = { ...exported, tasks: [{ ...a!, duty_id: null, occurrence_at: null }, b!], duties: [], links: [{ from_task_id: a!.id, to_task_id: b!.id, link_type: 'blocks' }, { from_task_id: b!.id, to_task_id: a!.id, link_type: 'blocks' }] };
      const semantic = await rest(input(cyclic, cursor)); expect(semantic.status).toBe(400);
      expect(await semantic.json()).toMatchObject({ error: { code: 'invalid_input', details: [{ code: 'cycle' }] } });
      expect((await rpc(input(cyclic, cursor))).result.isError).toBe(true);
      expect((await rest({ ...input(exported, cursor), mode: 'wipe' })).status).toBe(400);
      expect((await rest({ ...input(exported, cursor), extra: true })).status).toBe(400);
      expect((await rest({ ...input({ ...exported, tasks: 'x' }, cursor) })).status).toBe(400);
      expect((await rpc({ ...input(exported, cursor), expectedCursor: undefined })).result.isError).toBe(true);
      expect(sql.prepare('SELECT epoch FROM sync_metadata').get()).toEqual({ epoch: cursor.epoch });
      const applied = await rest(input(exported, cursor)); expect(applied.status).toBe(200);
      expect((await rest(input(exported, cursor))).status).toBe(409);
      sql.exec(wipeOut);
    } finally { sql.close(); }
  });
});
