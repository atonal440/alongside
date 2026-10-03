import { describe, expect, it } from 'vitest';
import { DB } from '../src/db';
import { handleMcpRequest } from '../src/mcp';
import { sqliteD1 } from './helpers/sqliteD1';

type World = ReturnType<typeof sqliteD1>;
async function call(w: World, name: string, args: Record<string, unknown> = {}) {
  const request = new Request('https://t/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  const body = await (await handleMcpRequest(request, new DB(w.d1), { DB: w.d1, AUTH_TOKEN: 't' })).json() as any;
  if (body.error) throw new Error(body.error.message);
  return body.result.structuredContent as any;
}
/** Every user table's row count plus the sync watermark: any write by a read tool shows up here. */
function fingerprint(w: World) {
  const tables = (w.sql.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map(t => t.name);
  return Object.fromEntries([...tables.map(t => [t, JSON.stringify(w.sql.prepare(`SELECT * FROM ${t}`).all())]), ['changes', (w.sql.prepare('SELECT total_changes() AS n').get() as any).n]]);
}
const withWorld = async (fn: (w: World) => Promise<void>) => { const w = sqliteD1(); try { await fn(w); } finally { w.sql.close(); } };

describe('start_session is read-only', () => {
  it('writes nothing: no seeded preferences, no last_session_at, no log, no sync event', async () => withWorld(async w => {
    await call(w, 'add_task', { title: 'Something' });
    const before = fingerprint(w);
    const result = await call(w, 'start_session');
    await call(w, 'start_session');
    expect(fingerprint(w)).toEqual(before);
    expect(w.sql.prepare('SELECT COUNT(*) AS n FROM user_preferences').get()).toEqual({ n: 0 });
    expect(result.suggested_tasks).toHaveLength(1);
  }));

  it('returns defaults merged in memory, with stored values winning', async () => withWorld(async w => {
    const defaults = (await call(w, 'start_session')).preferences;
    expect(defaults).toMatchObject({ sort_by: 'readiness' });
    await call(w, 'update_preference', { key: 'sort_by', value: 'due' });
    const merged = (await call(w, 'start_session')).preferences;
    expect(merged.sort_by).toBe('due');
    expect(Object.keys(merged).sort()).toEqual(Object.keys(defaults).sort());
  }));

  it('is annotated read-only on the tool list', async () => {
    const { TOOLS } = await import('../src/mcp');
    expect(TOOLS.find(t => t.name === 'start_session')!.annotations).toMatchObject({ readOnlyHint: true });
  });
});

describe('returning_after_gap comes from history', () => {
  const log = (w: World, createdAt: string) => w.sql.prepare("INSERT INTO action_log(tool_name,title,created_at) VALUES('add_task','Old',?)").run(createdAt);
  const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

  it('is false on an empty workspace and with recent activity', async () => withWorld(async w => {
    expect((await call(w, 'start_session')).returning_after_gap).toBe(false);
    log(w, daysAgo(1));
    expect((await call(w, 'start_session')).returning_after_gap).toBe(false);
  }));

  it('is true when the newest action-log entry is older than seven days', async () => withWorld(async w => {
    log(w, daysAgo(8)); log(w, daysAgo(30));
    expect((await call(w, 'start_session')).returning_after_gap).toBe(true);
  }));

  it('counts command-audit activity as recent even when the action log is old', async () => withWorld(async w => {
    log(w, daysAgo(40));
    expect((await call(w, 'start_session')).returning_after_gap).toBe(true);
    await call(w, 'update_preference', { key: 'sort_by', value: 'due' });          // writes a command audit row, no log row
    expect((await call(w, 'start_session')).returning_after_gap).toBe(false);
  }));

  it('ignores a stale stored last_session_at', async () => withWorld(async w => {
    await call(w, 'update_preference', { key: 'last_session_at', value: daysAgo(30) });
    w.sql.prepare('DELETE FROM command_audit').run();                              // leave no recent activity beyond that
    log(w, daysAgo(1));
    expect((await call(w, 'start_session')).returning_after_gap).toBe(false);
  }));
});
