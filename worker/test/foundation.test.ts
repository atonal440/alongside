import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DB } from '../src/db';
import { handleApiRequest } from '../src/api';
import { handleMcpRequest } from '../src/mcp';
import { callFoundationTool } from '../src/foundation';
import { classifyLegacyDue } from '../src/domain/temporalFoundation';
import { parseTimezone, parseSchema } from '@shared/parse';
import { CapabilitiesSchema, TimeResolutionSchema, parseLegacyDatesPreview } from '@shared/wire/planning';

function sqliteDb(upgrade = false) {
  const sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys = ON');
  if (upgrade) {
    const dir = fileURLToPath(new URL('../migrations/', import.meta.url));
    for (const name of readdirSync(dir).filter(name => name.endsWith('.sql')).sort()) sql.exec(readFileSync(`${dir}/${name}`, 'utf8'));
  } else sql.exec(readFileSync(fileURLToPath(new URL('../schema.sql', import.meta.url)), 'utf8'));
  const d1 = { prepare(query: string) {
    let args: unknown[] = [];
    return {
      bind(...values: unknown[]) { args = values; return this; },
      async first() { return sql.prepare(query).get(...args as never[]) ?? null; },
      async all() { return { results: sql.prepare(query).all(...args as never[]), success: true }; },
    };
  } } as unknown as D1Database;
  return { db: new DB(d1), sql };
}
const now = '2026-09-30T23:00:00.123Z';
const req = (method: string, path: string, body?: unknown) => new Request(`https://alongside.test${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

describe('Slice 1 REST/MCP foundation', () => {
  it('reports explicit UTC fallback and honest feature/delivery gates', async () => {
    const { db } = sqliteDb();
    const capabilities = await callFoundationTool('get_capabilities', {}, db, now);
    expect(parseSchema(CapabilitiesSchema, capabilities).ok).toBe(true);
    expect(capabilities).toMatchObject({ serverNow: now, timezone: 'UTC', timezoneSource: 'fallback_utc', setupRequired: true, features: { reliableCommands: false, taskDates: false, reminders: false }, delivery: { webPush: 'unconfigured', backgroundEnabled: false } });
  });
  it('reads and validates stored settings and supports explicit request zones', async () => {
    const { db, sql } = sqliteDb();
    sql.exec(`INSERT INTO planning_settings VALUES (1, 'America/Los_Angeles', 15, 0, '${now}', '${now}'); INSERT INTO planning_working_hours VALUES (1, 1, '09:00', '17:00');`);
    expect(await db.getPlanningSettings()).toMatchObject({ timezone: 'America/Los_Angeles', workingHours: [{ weekday: 1, start: '09:00', end: '17:00' }], bufferMinutes: 15, revision: 0 });
    expect(await callFoundationTool('get_capabilities', {}, db, now)).toMatchObject({ timezoneSource: 'workspace', setupRequired: false });
    expect(await callFoundationTool('get_capabilities', { timezone: 'Pacific/Kiritimati' }, db, now)).toMatchObject({ timezone: 'Pacific/Kiritimati', timezoneSource: 'request' });
    sql.exec("UPDATE planning_settings SET timezone = 'Bogus/Zone'");
    await expect(db.getPlanningSettings()).rejects.toThrow('validation');
  });
  it('shares resolution and structured errors between REST and MCP', async () => {
    const { db } = sqliteDb();
    const args = { kind: 'wall_time', date: '2026-11-01', time: '01:30', timezone: 'America/Los_Angeles' };
    const request = req('POST', '/api/v2/resolve-time', args);
    const rest = await handleApiRequest(request, new URL(request.url), db);
    expect(rest.status).toBe(400);
    expect(await rest.json()).toMatchObject({ contractVersion: 2, error: { code: 'ambiguous_local_time', retryable: false } });
    const rpc = req('POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'resolve_time', arguments: args } });
    const response = await handleMcpRequest(rpc, db, { DB: {} as D1Database, AUTH_TOKEN: 'test' });
    expect(await response.json()).toMatchObject({ result: { isError: true, structuredContent: { error: { code: 'ambiguous_local_time' } } } });
    const result = await callFoundationTool('resolve_time', { ...args, disambiguation: 'later' }, db, now);
    expect(parseSchema(TimeResolutionSchema, result).ok).toBe(true);
    expect(result).toMatchObject({ at: '2026-11-01T09:30:00Z' });
  });
  it.each([
    ['GET', '/api/v2/capabilities?timezone=UTC&timezone=UTC', undefined],
    ['GET', '/api/v2/capabilities?unknown=true', undefined],
    ['POST', '/api/v2/resolve-time', { kind: 'wall_time', date: '2026-09-30', time: '09:00', extra: 'x' }],
    ['POST', '/api/v2/resolve-time', { kind: 'wall_time', date: '2026-09-30', time: '09:00', timezone: null }],
    ['POST', '/api/v2/resolve-time?timezone=UTC', { kind: 'wall_time', date: '2026-09-30', time: '09:00' }],
  ])('rejects strict boundary violation %s %s', async (method, path, body) => {
    const { db } = sqliteDb();
    const request = req(method, path, body);
    expect((await handleApiRequest(request, new URL(request.url), db)).status).toBe(400);
  });
  it('keeps malformed JSON and wrong methods/paths from dispatching', async () => {
    const { db } = sqliteDb();
    const request = new Request('https://alongside.test/api/v2/resolve-time', { method: 'POST', body: '{' });
    expect((await handleApiRequest(request, new URL(request.url), db)).status).toBe(400);
    for (const path of ['/api/v2/resolve-time/', '/api/v2/capabilities']) {
      const wrong = req('POST', path, {});
      expect((await handleApiRequest(wrong, new URL(wrong.url), db)).status).toBe(404);
    }
  });
  it('previews legacy rows without writes, preserving ambiguity and paging', async () => {
    const { db, sql } = sqliteDb();
    sql.exec(`INSERT INTO tasks (id,title,created_at,updated_at,due_date,due_all_day) VALUES
      ('t_aaaaa','All day','${now}','${now}','2026-09-30T12:00:00Z',1),
      ('t_bbbbb','Timed noon','${now}','${now}','2026-09-30T12:00:00Z',0),
      ('t_ccccc','Ambiguous','${now}','${now}','2026-09-30T12:00:00Z',NULL),
      ('t_ddddd','Corrupt','${now}','${now}','invalid',NULL);`);
    const before = sql.prepare('SELECT * FROM tasks ORDER BY id').all();
    const first = await callFoundationTool('preview_legacy_dates', { timezone: 'Pacific/Kiritimati', limit: 2 }, db, now);
    expect(parseLegacyDatesPreview(first).ok).toBe(true);
    expect(first).toMatchObject({ dryRun: true, consistentSnapshot: false, nextCursor: 't_bbbbb', candidates: [
      { role: 'target', point: { kind: 'date', date: '2026-09-30', timezone: 'Pacific/Kiritimati' }, provenance: 'legacy_all_day', original: { due_date: '2026-09-30T12:00:00Z', due_all_day: true } },
      { role: 'target', point: { kind: 'instant', at: '2026-09-30T12:00:00Z' }, provenance: 'legacy_timed' },
    ] });
    const second = await callFoundationTool('preview_legacy_dates', { after: 't_bbbbb', limit: 2 }, db, now);
    expect(parseLegacyDatesPreview(second).ok).toBe(true);
    expect(second).toMatchObject({ nextCursor: null, candidates: [{ provenance: 'legacy_ambiguous' }], unresolved: [{ taskId: 't_ddddd' }] });
    expect(sql.prepare('SELECT * FROM tasks ORDER BY id').all()).toEqual(before);
  });
});

describe.each([false, true])('planning schema fresh/upgrade (%s)', upgrade => {
  it('constrains settings and leaves old due values untouched', () => {
    const { sql } = sqliteDb(upgrade);
    expect(sql.prepare('SELECT * FROM planning_settings').all()).toEqual([]);
    expect(() => sql.exec(`INSERT INTO planning_settings VALUES(2,'UTC',0,0,'${now}','${now}')`)).toThrow(/CHECK/);
    sql.exec(`INSERT INTO planning_settings VALUES(1,'UTC',0,0,'${now}','${now}')`);
    expect(() => sql.exec('UPDATE planning_settings SET revision = -1')).toThrow(/CHECK/);
    expect(() => sql.exec('UPDATE planning_settings SET revision = 0.5')).toThrow(/CHECK/);
    expect(() => sql.exec('UPDATE planning_settings SET buffer_minutes = 0.5')).toThrow(/CHECK/);
    expect(() => sql.exec("INSERT INTO planning_working_hours VALUES(1,1,'09:00','09:00')")).toThrow(/CHECK/);
    expect(() => sql.exec("INSERT INTO planning_working_hours VALUES(1,8,'09:00','17:00')")).toThrow(/CHECK/);
    expect(() => sql.exec("INSERT INTO planning_working_hours VALUES(1,1,'29:00','30:00')")).toThrow(/CHECK/);
  });
});

it('009 upgrade preserves representative legacy task values byte for byte', () => {
  const sql = new DatabaseSync(':memory:');
  const dir = fileURLToPath(new URL('../migrations/', import.meta.url));
  for (const name of readdirSync(dir).filter(name => name.endsWith('.sql')).sort()) {
    if (name === '009_planning_foundation.sql') break;
    sql.exec(readFileSync(`${dir}/${name}`, 'utf8'));
  }
  sql.exec(`INSERT INTO tasks(id,title,created_at,updated_at,due_date,due_all_day,recurrence) VALUES
    ('t_aaaaa','Ambiguous','${now}','${now}','2026-09-30T12:00:00Z',NULL,'FREQ=WEEKLY'),
    ('t_bbbbb','All day','${now}','${now}','2026-09-30T12:00:00Z',1,NULL),
    ('t_ccccc','Timed','${now}','${now}','2026-09-30T12:00:00Z',0,NULL);`);
  const before = sql.prepare('SELECT * FROM tasks ORDER BY id').all();
  sql.exec(readFileSync(`${dir}/009_planning_foundation.sql`, 'utf8'));
  expect(sql.prepare('SELECT * FROM tasks ORDER BY id').all()).toEqual(before);
  sql.close();
});

it('fresh-db migration bookkeeping includes every migration reflected in schema.sql', () => {
  const dir = fileURLToPath(new URL('../migrations/', import.meta.url));
  const migrations = readdirSync(dir).filter(name => name.endsWith('.sql')).sort();
  const script = readFileSync(fileURLToPath(new URL('../scripts/seed-migrations.mjs', import.meta.url)), 'utf8');
  const seeded = Array.from(script.matchAll(/'(\d{3}_[^']+\.sql)'/g), match => match[1]).sort();
  expect(seeded).toEqual(migrations);
});
