import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DB } from '../src/db';
import { handleApiRequest } from '../src/api';
import { handleMcpRequest } from '../src/mcp';
import { callCommandTool, COMMAND_TOOLS } from '../src/commands';
import { commandHash, planSettingsCommand } from '../src/domain/commands';
import { applyPlan, checkPlanCapacity } from '../src/storage/apply';
import { parseEventInstant } from '@shared/parse';
import { parseCommandEnvelope, parseChangesResult, parseChangesPreview, parsePlanningSettingsExport, parsePlanningSettingsResponse } from '@shared/wire/commands';
import { parseFoundationErrorEnvelope } from '@shared/wire/planning';

const stamp = '2026-10-01T01:00:00.123Z';
const values = { timezone: 'America/Los_Angeles', bufferMinutes: 15, workingHours: [
  { weekday: 1, start: '09:00', end: '12:00' }, { weekday: 1, start: '13:00', end: '17:00' },
] };
function command(commandId = 'c_first1', expectedRevision: number | null = null, settings = values) {
  const parsed = parseCommandEnvelope({ contractVersion: 2, commandId, actor: 'llm', reason: 'Workspace setup', commands: [{ kind: 'planning.set', expectedRevision, values: settings }] });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
  return parsed.value;
}
function fixture(upgrade = false) {
  const sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys = ON');
  if (upgrade) {
    const dir = fileURLToPath(new URL('../migrations/', import.meta.url));
    for (const name of readdirSync(dir).filter(name => name.endsWith('.sql')).sort()) sql.exec(readFileSync(`${dir}/${name}`, 'utf8'));
  } else sql.exec(readFileSync(fileURLToPath(new URL('../schema.sql', import.meta.url)), 'utf8'));
  const batches: number[] = [];
  const hooks: { beforeBatch?: () => Promise<void>; beforeSettingsRead?: () => Promise<void>; failureSql?: string; loseResponse?: boolean } = {};
  function prepare(query: string) {
    let args: unknown[] = [];
    return { query, args: () => args,
      bind(...values: unknown[]) { args = values; return this; },
      async first() {
        if (query.includes('json_group_array') && hooks.beforeSettingsRead) {
          const hook = hooks.beforeSettingsRead; delete hooks.beforeSettingsRead; await hook();
        }
        return sql.prepare(query).get(...args as never[]) ?? null;
      },
      async all() { return { success: true, results: sql.prepare(query).all(...args as never[]) }; },
    };
  }
  const d1 = { prepare, async batch(statements: ReturnType<typeof prepare>[]) {
    if (hooks.beforeBatch) { const hook = hooks.beforeBatch; delete hooks.beforeBatch; await hook(); }
    batches.push(statements.length);
    sql.exec('BEGIN');
    try {
      const results = statements.map(statement => {
        if (hooks.failureSql && statement.query.includes(hooks.failureSql)) throw new Error('Injected storage failure');
        sql.prepare(statement.query).run(...statement.args() as never[]);
        return { success: true, results: [], meta: {} };
      });
      sql.exec('COMMIT');
      if (hooks.loseResponse) { delete hooks.loseResponse; throw new Error('Lost response after commit'); }
      return results;
    } catch (error) {
      if (sql.isTransaction) sql.exec('ROLLBACK');
      throw error;
    }
  } } as unknown as D1Database;
  return { sql, d1, db: new DB(d1), hooks, batches };
}
const request = (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => new Request(`https://alongside.test${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

describe.each([false, true])('settings reliable command fresh/upgrade (%s)', upgrade => {
  it('previews without writes and commits values, receipt, audit and feed atomically', async () => {
    const { db, sql, batches } = fixture(upgrade);
    const input = command();
    const preview = await db.previewChanges(input);
    expect(parseChangesPreview(preview).ok).toBe(true);
    expect(preview).toMatchObject({ dryRun: true, requiredStatements: 8, changes: [{ before: null, after: { ...values, revision: 1 } }] });
    expect(batches).toEqual([]);
    expect(sql.prepare('SELECT * FROM command_receipts').all()).toEqual([]);
    expect(await db.getPlanningSettings()).toBeNull();
    const result = await db.applyChanges(input);
    expect(parseChangesResult(result).ok).toBe(true);
    expect(batches).toEqual([8]);
    expect(await db.getPlanningSettings()).toEqual({ ...values, revision: 1 });
    expect(sql.prepare('SELECT command_id,actor,reason FROM command_audit').get()).toEqual({ command_id: input.commandId, actor: 'llm', reason: 'Workspace setup' });
    const receipt = sql.prepare('SELECT result_json FROM command_receipts').get()!;
    expect(JSON.parse(receipt.result_json as string)).toEqual(result);
    const feed = sql.prepare('SELECT seq,revision,payload_json FROM change_feed').get()!;
    expect(feed).toMatchObject({ seq: 1, revision: 1 });
    expect(JSON.parse(feed.payload_json as string)).toEqual({ ...values, revision: 1 });
    sql.close();
  });
});

it('returns the original receipt after replay, even after a later edit', async () => {
  const { db, sql, batches } = fixture();
  const input = command();
  const first = await db.applyChanges(input);
  await db.applyChanges(command('c_later1', 1, { ...values, bufferMinutes: 30 }));
  expect(await db.applyChanges(input)).toEqual(first);
  await expect(db.previewChanges(input)).rejects.toMatchObject({ detail: { code: 'already_applied' } });
  expect(await db.getPlanningSettings()).toMatchObject({ revision: 2, bufferMinutes: 30 });
  expect(batches).toEqual([8, 8]);
  expect(sql.prepare('SELECT COUNT(*) AS n FROM change_feed').get()).toMatchObject({ n: 2 });
  sql.close();
});
it('normalizes property and working-hour order without conflating different intent', async () => {
  const { db, sql, batches } = fixture();
  const input = command();
  const shuffled = command('c_first1', null, { workingHours: [...values.workingHours].reverse(), bufferMinutes: 15, timezone: values.timezone });
  expect(await commandHash(shuffled)).toBe(await commandHash(input));
  const first = await db.applyChanges(input);
  expect(await db.applyChanges(shuffled)).toEqual(first);
  await expect(db.applyChanges(command('c_first1', null, { ...values, bufferMinutes: 20 }))).rejects.toMatchObject({ status: 409, detail: { code: 'command_id_conflict', path: ['commandId'] } });
  await expect(db.previewChanges(command('c_first1', 1, { ...values, bufferMinutes: 20 }))).rejects.toMatchObject({ detail: { code: 'command_id_conflict' } });
  expect(batches).toEqual([8]);
  sql.close();
});
it('retains current values in stale revision diagnostics without changing any state', async () => {
  const { db, sql, batches } = fixture();
  await db.applyChanges(command());
  const before = sql.prepare('SELECT * FROM planning_settings').all();
  await expect(db.applyChanges(command('c_stale1', null))).rejects.toMatchObject({ status: 409, detail: { code: 'revision_conflict', expectedRevision: null, currentSettings: { ...values, revision: 1 } } });
  expect(sql.prepare('SELECT * FROM planning_settings').all()).toEqual(before);
  expect(batches).toEqual([8]);
  expect(sql.prepare("SELECT * FROM command_receipts WHERE command_id='c_stale1'").all()).toEqual([]);
  sql.close();
});
it('aborts all mutations when another command wins after the pre-read', async () => {
  const { db, sql, hooks } = fixture();
  await db.applyChanges(command());
  hooks.beforeBatch = async () => { await db.applyChanges(command('c_winner', 1, { ...values, bufferMinutes: 45 })); };
  await expect(db.applyChanges(command('c_loser1', 1, { ...values, bufferMinutes: 30 }))).rejects.toMatchObject({ detail: { code: 'revision_conflict', currentSettings: { revision: 2, bufferMinutes: 45 } } });
  expect(sql.prepare("SELECT * FROM command_receipts WHERE command_id='c_loser1'").all()).toEqual([]);
  expect(sql.prepare('SELECT COUNT(*) AS n FROM command_audit').get()).toMatchObject({ n: 2 });
  expect(sql.prepare('SELECT COUNT(*) AS n FROM change_feed').get()).toMatchObject({ n: 2 });
  expect(await db.getPlanningSettings()).toMatchObject({ revision: 2, bufferMinutes: 45 });
  sql.close();
});
it.each(['before-read', 'before-batch'])('rereads a concurrently committed identical receipt (%s)', async point => {
  const { db, sql, hooks } = fixture();
  const input = command();
  let winner: unknown;
  const race = async () => { winner = await db.applyChanges(input); };
  if (point === 'before-read') hooks.beforeSettingsRead = race;
  else hooks.beforeBatch = race;
  expect(await db.applyChanges(input)).toEqual(winner);
  expect(sql.prepare('SELECT COUNT(*) AS n FROM command_receipts').get()).toMatchObject({ n: 1 });
  expect(sql.prepare('SELECT COUNT(*) AS n FROM change_feed').get()).toMatchObject({ n: 1 });
  sql.close();
});
it('recovers a lost batch response from the committed receipt', async () => {
  const { db, sql, hooks } = fixture();
  hooks.loseResponse = true;
  const input = command();
  const result = await db.applyChanges(input);
  expect(await db.applyChanges(input)).toEqual(result);
  expect(sql.prepare('SELECT COUNT(*) AS n FROM change_feed').get()).toMatchObject({ n: 1 });
  sql.close();
});
it.each(['command_audit', 'change_feed'])('rolls back values and receipt on a late %s failure', async failureSql => {
  const { db, sql, hooks } = fixture();
  hooks.failureSql = failureSql;
  await expect(db.applyChanges(command())).rejects.toMatchObject({ status: 503, detail: { code: 'storage_unavailable', retryable: true } });
  for (const table of ['planning_settings', 'planning_working_hours', 'command_receipts', 'command_audit', 'change_feed']) {
    expect(sql.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
  }
  delete hooks.failureSql;
  expect(await db.applyChanges(command())).toMatchObject({ applied: true });
  sql.close();
});
it('counts revision guard, settings rows, receipts, feed and audit using the shared compiler', async () => {
  const { d1, sql } = fixture();
  const input = command();
  const now = parseEventInstant(stamp);
  if (!now.ok) throw new Error();
  const plan = planSettingsCommand(input, null, await commandHash(input), now.value).plan;
  expect(checkPlanCapacity(d1, plan)).toMatchObject({ ok: true, value: { requiredStatements: 8 } });
  plan.ops.push(...Array.from({ length: 93 }, () => plan.ops[2]!));
  expect(await applyPlan(d1, plan)).toMatchObject({ ok: false, error: { kind: 'capacity_exceeded', requiredStatements: 101 } });
  expect(sql.prepare('SELECT * FROM command_receipts').all()).toEqual([]);
  sql.close();
});
it('exports/restores settings values with new command identity and current revision', async () => {
  const first = fixture();
  await first.db.applyChanges(command());
  const exported = await callCommandTool('export_planning_settings', {}, first.db);
  const decoded = parsePlanningSettingsExport(exported);
  if (!decoded.ok || !decoded.value.values) throw new Error();
  expect(decoded.value.values).toEqual(values);
  expect(JSON.stringify(exported)).not.toMatch(/commandId|revision|AUTH_TOKEN/);
  const second = fixture(true);
  await second.db.applyChanges(command('c_restore', null, decoded.value.values));
  expect(await second.db.getPlanningSettings()).toEqual({ ...values, revision: 1 });
  expect(parsePlanningSettingsResponse(await callCommandTool('get_planning_settings', {}, second.db)).ok).toBe(true);
  first.sql.close(); second.sql.close();
});
it('rejects corrupt stored receipts instead of trusting raw JSON', async () => {
  const { db, sql } = fixture();
  await db.applyChanges(command());
  sql.exec("UPDATE command_receipts SET result_json='{}'");
  await expect(db.applyChanges(command())).rejects.toThrow('validation');
  sql.close();
});

describe('REST/MCP command boundaries', () => {
  it('shares normalized results and structured revision errors through both interfaces', async () => {
    const { db, sql } = fixture();
    const input = command();
    const restReq = request('/api/v2/changes', input);
    const rest = await handleApiRequest(restReq, new URL(restReq.url), db);
    expect(rest.status).toBe(200);
    const result = await rest.json();
    expect(parseChangesResult(result).ok).toBe(true);
    const rpc = request('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'apply_changes', arguments: input } });
    expect(await (await handleMcpRequest(rpc, db, { DB: {} as D1Database, AUTH_TOKEN: 'test' })).json()).toMatchObject({ result: { structuredContent: result } });
    const stale = request('/api/v2/changes', command('c_stale2', null));
    const conflict = await handleApiRequest(stale, new URL(stale.url), db);
    expect(conflict.status).toBe(409);
    expect(parseFoundationErrorEnvelope(await conflict.json()).ok).toBe(true);
    const staleRpc = request('/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'apply_changes', arguments: command('c_stale3', null) } });
    expect(await (await handleMcpRequest(staleRpc, db, { DB: {} as D1Database, AUTH_TOKEN: 'test' })).json()).toMatchObject({ result: { isError: true, structuredContent: { contractVersion: 2, error: { code: 'revision_conflict', currentSettings: { revision: 1 } } } } });
    expect(COMMAND_TOOLS.find(tool => tool.name === 'apply_changes')?.inputSchema).toMatchObject({ required: ['contractVersion', 'commandId', 'actor', 'commands'] });
    sql.close();
  });
  it.each([
    {}, { ...command(), extra: true }, { ...command(), contractVersion: 1 }, { ...command(), commandId: 'raw' },
    { ...command(), commands: [] }, { ...command(), commands: [command().commands[0], command().commands[0]] },
    { ...command(), commands: [{ ...command().commands[0], values: { ...values, revision: 1 } }] },
    { ...command(), commands: [{ ...command().commands[0], expectedRevision: 1.5 }] },
    { ...command(), commands: [{ ...command().commands[0], values: { ...values, workingHours: [values.workingHours[0], values.workingHours[0]] } }] },
  ])('rejects invalid commands before writes', async body => {
    const { db, sql, batches } = fixture();
    const req = request('/api/v2/changes', body);
    const response = await handleApiRequest(req, new URL(req.url), db);
    expect(response.status).toBe(400);
    expect(parseFoundationErrorEnvelope(await response.json()).ok).toBe(true);
    expect(batches).toEqual([]);
    sql.close();
  });
  it('rejects malformed JSON, unknown query keys and wrong methods', async () => {
    const { db, sql } = fixture();
    const badJson = new Request('https://alongside.test/api/v2/changes', { method: 'POST', body: '{' });
    expect((await handleApiRequest(badJson, new URL(badJson.url), db)).status).toBe(400);
    const query = request('/api/v2/planning-settings?ignored=1');
    expect((await handleApiRequest(query, new URL(query.url), db)).status).toBe(400);
    const wrong = request('/api/v2/changes');
    expect((await handleApiRequest(wrong, new URL(wrong.url), db)).status).toBe(404);
    sql.close();
  });
});
