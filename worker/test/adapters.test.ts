import { describe, expect, it } from 'vitest';
import { DB } from '../src/db';
import { handleMcpRequest } from '../src/mcp';
import { sqliteD1 } from './helpers/sqliteD1';

type World = ReturnType<typeof sqliteD1>;
async function call(w: World, name: string, args: Record<string, unknown>) {
  const request = new Request('https://t/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  const body = await (await handleMcpRequest(request, new DB(w.d1), { DB: w.d1, AUTH_TOKEN: 't' })).json() as any;
  if (body.error) throw Object.assign(new Error(body.error.message), { rpc: true });
  if (body.result.isError) throw Object.assign(new Error(body.result.content[0].text), { detail: body.result.structuredContent.error });
  return body.result.structuredContent as any;
}
const rows = (w: World, table: string) => w.sql.prepare(`SELECT * FROM ${table}`).all() as any[];
const logs = (w: World) => rows(w, 'action_log').length;
const withWorld = async (fn: (w: World, db: DB) => Promise<void>) => { const w = sqliteD1(); try { await fn(w, new DB(w.d1)); } finally { w.sql.close(); } };

describe('receipt-first replay', () => {
  it('replays add_task verbatim: one task, one log row, same response and ID', async () => withWorld(async w => {
    const first = await call(w, 'add_task', { title: 'Once', due_date: '2026-11-01', commandId: 'c_replay01' });
    const again = await call(w, 'add_task', { title: 'Once', due_date: '2026-11-01', commandId: 'c_replay01' });
    expect(again).toEqual(first);
    expect(rows(w, 'tasks')).toHaveLength(1);
    expect(logs(w)).toBe(1);
    expect(first.action_log_entry).toEqual({ tool_name: 'add_task', title: 'Once', detail: '2026-11-01T12:00:00Z' });
    expect(rows(w, 'command_receipts')).toHaveLength(1);
  }));

  it('mints a fresh command per call without a commandId', async () => withWorld(async w => {
    const a = await call(w, 'add_task', { title: 'Same' }); const b = await call(w, 'add_task', { title: 'Same' });
    expect(a.id).not.toBe(b.id);
    expect(rows(w, 'tasks')).toHaveLength(2);
    expect(logs(w)).toBe(2);
  }));

  it('refuses a different request on a used command ID and writes nothing', async () => withWorld(async w => {
    await call(w, 'add_task', { title: 'First', commandId: 'c_conflict' });
    await expect(call(w, 'add_task', { title: 'Second', commandId: 'c_conflict' })).rejects.toMatchObject({ detail: { code: 'command_id_conflict' } });
    await expect(call(w, 'update_task', { task_id: 't_whatever', title: 'x', commandId: 'c_conflict' })).rejects.toMatchObject({ detail: { code: 'command_id_conflict' } });
    expect(rows(w, 'tasks')).toHaveLength(1);
    expect(logs(w)).toBe(1);
  }));

  it('replays a recurring completion with the same successor and one log row, whatever changed since', async () => withWorld(async w => {
    const task = await call(w, 'add_task', { title: 'Weekly', due_date: '2026-10-05', recurrence: 'FREQ=WEEKLY' });
    const first = await call(w, 'complete_task', { task_id: task.id, commandId: 'c_recur001' });
    expect(first.next.id).toMatch(/^t_[0-9a-f]{12}$/);
    await call(w, 'update_task', { task_id: first.next.id, title: 'Renamed successor' });
    const again = await call(w, 'complete_task', { task_id: task.id, commandId: 'c_recur001' });
    expect(again).toEqual(first);                                    // original successor row, not the renamed one
    expect(rows(w, 'tasks')).toHaveLength(2);
    expect(rows(w, 'action_log').filter(r => r.tool_name === 'complete_task')).toHaveLength(1);
  }));

  it('stores a version 2 receipt whose result is one change for a multi-group update', async () => withWorld(async w => {
    const task = await call(w, 'add_task', { title: 'T' });
    await call(w, 'update_task', { task_id: task.id, title: 'U', due_date: '2026-11-02', commandId: 'c_multi001' });
    const stored = JSON.parse((w.sql.prepare("SELECT result_json FROM command_receipts WHERE command_id='c_multi001'").get() as any).result_json);
    expect(stored).toMatchObject({ receiptVersion: 2, tool: 'update_task' });
    expect(stored.result.changes).toHaveLength(1);
    expect(stored.response.title).toBe('U');
    expect(logs(w)).toBe(2);
  }));
});

describe('racing identical requests', () => {
  it('plans the same identities, so the loser replays the winner', async () => withWorld(async (w, db) => {
    const args = { title: 'Raced', commandId: 'c_raced001' };
    let winner: any;
    w.hooks.beforeBatch = async () => { winner = await call(w, 'add_task', args); };
    const loser = await call(w, 'add_task', args);
    expect(loser).toEqual(winner);
    expect(await db.listAllTasks()).toHaveLength(1);
    expect(logs(w)).toBe(1);
  }));
});

describe('bounded retry of unpinned writes', () => {
  it('wins a revision race on retry by re-merging the patch against the new values', async () => withWorld(async w => {
    const task = await call(w, 'add_task', { title: 'Old', notes: 'before' });
    w.hooks.beforeBatch = () => { w.sql.prepare("UPDATE tasks SET notes='raced' WHERE id=?").run(task.id); };
    const result = await call(w, 'update_task', { task_id: task.id, title: 'New' });
    expect(result).toMatchObject({ title: 'New', notes: 'raced' });     // the concurrent notes edit survives
    expect(logs(w)).toBe(2);
  }));

  it('wins a structural race on retry (complete_task pins the workspace structure)', async () => withWorld(async w => {
    const task = await call(w, 'add_task', { title: 'Done soon' });
    w.hooks.beforeBatch = () => { w.sql.exec("INSERT INTO tasks(id,title,created_at,updated_at) VALUES('t_other01','Other','2026-10-03T12:00:00.000Z','2026-10-03T12:00:00.000Z')"); };
    const result = await call(w, 'complete_task', { task_id: task.id });
    expect(result.completed.status).toBe('done');
    expect(logs(w)).toBe(2);
  }));

  it('gives up after a fixed number of attempts and reports the conflict', async () => withWorld(async w => {
    const task = await call(w, 'add_task', { title: 'Contended' });
    let raced = 0;
    const arm = () => { w.hooks.beforeBatch = () => { raced++; w.sql.prepare("UPDATE tasks SET notes=? WHERE id=?").run(`n${raced}`, task.id); arm(); }; };
    arm();
    await expect(call(w, 'update_task', { task_id: task.id, title: 'Never' })).rejects.toMatchObject({ detail: { code: 'revision_conflict' } });
    expect(raced).toBe(3);
    expect((rows(w, 'tasks')[0] as any).title).toBe('Contended');
    expect(logs(w)).toBe(1);                                            // no log row for the failed call
  }));

  it('never retries a caller-pinned expectedRevision', async () => withWorld(async w => {
    const task = await call(w, 'add_task', { title: 'Pinned' });
    const revision = (w.sql.prepare("SELECT revision FROM entity_versions WHERE entity_key=?").get(task.id) as any).revision;
    let raced = 0;
    w.hooks.beforeBatch = () => { raced++; w.sql.prepare("UPDATE tasks SET notes='x' WHERE id=?").run(task.id); };
    await expect(call(w, 'update_task', { task_id: task.id, title: 'Mine', expectedRevision: revision })).rejects.toMatchObject({ detail: { code: 'revision_conflict' } });
    expect(raced).toBe(1);
    await expect(call(w, 'focus_task', { task_id: task.id, expectedRevision: revision })).rejects.toMatchObject({ detail: { code: 'revision_conflict' } });
    expect((rows(w, 'tasks')[0] as any).title).toBe('Pinned');
  }));

  it('accepts a correct expectedRevision', async () => withWorld(async w => {
    const task = await call(w, 'add_task', { title: 'Pinned' });
    const revision = (w.sql.prepare("SELECT revision FROM entity_versions WHERE entity_key=?").get(task.id) as any).revision;
    expect(await call(w, 'update_task', { task_id: task.id, title: 'Ok', expectedRevision: revision })).toMatchObject({ title: 'Ok' });
  }));
});

describe('no-op receipts', () => {
  it('records the call, logs once, and replays the stored response even after state changes', async () => withWorld(async w => {
    const task = await call(w, 'add_task', { title: 'Pending already' });
    const first = await call(w, 'update_task', { task_id: task.id, status: 'pending', commandId: 'c_noop0001' });
    expect(first.status).toBe('pending');
    expect(logs(w)).toBe(2);
    const stored = JSON.parse((w.sql.prepare("SELECT result_json FROM command_receipts WHERE command_id='c_noop0001'").get() as any).result_json);
    expect(stored).toMatchObject({ receiptVersion: 2, tool: 'update_task', result: null });
    await call(w, 'complete_task', { task_id: task.id });               // another client completes it
    const retry = await call(w, 'update_task', { task_id: task.id, status: 'pending', commandId: 'c_noop0001' });
    expect(retry).toEqual(first);
    expect((rows(w, 'tasks')[0] as any).status).toBe('done');          // the retry did not reopen it
    expect(rows(w, 'action_log').filter(r => r.tool_name === 'update_task')).toHaveLength(1);
  }));

  it('re-evaluates when the state a no-op was judged against moves before commit', async () => withWorld(async w => {
    const task = await call(w, 'add_task', { title: 'Judged' });
    // Between classification (pending, so nothing to do) and commit, a concurrent client completes the task.
    w.hooks.beforeBatch = () => { w.sql.prepare("UPDATE tasks SET status='done' WHERE id=?").run(task.id); };
    const result = await call(w, 'update_task', { task_id: task.id, status: 'pending' });
    expect(result.status).toBe('pending');                              // on retry it was a real reopen
    expect(rows(w, 'action_log').filter(r => r.tool_name === 'update_task')).toHaveLength(1);
    expect((rows(w, 'tasks')[0] as any).status).toBe('pending');
  }));

  it('an empty patch on a missing task is refused without a receipt or log row', async () => withWorld(async w => {
    await expect(call(w, 'update_task', { task_id: 't_missing', commandId: 'c_missing1' })).rejects.toMatchObject({ detail: { code: 'not_found' } });
    expect(rows(w, 'command_receipts')).toHaveLength(0);
    expect(logs(w)).toBe(0);
  }));
});

describe('update_task field groups', () => {
  it('maps undeclared defer fields to the deferral command and keeps ignoring unknown keys', async () => withWorld(async w => {
    const task = await call(w, 'add_task', { title: 'T' });
    const deferred = await call(w, 'update_task', { task_id: task.id, defer_kind: 'someday', colour: 'red' });
    expect(deferred).toMatchObject({ defer_kind: 'someday' });
    await expect(call(w, 'update_task', { task_id: task.id, defer_until: '2026-12-01T09:00:00Z' })).rejects.toMatchObject({ detail: { code: 'invalid_input' } });
  }));

  it('keeps the other schedule fields when only one changes', async () => withWorld(async w => {
    const task = await call(w, 'add_task', { title: 'Weekly', due_date: '2026-10-05', recurrence: 'FREQ=WEEKLY' });
    expect(await call(w, 'update_task', { task_id: task.id, due_date: '2026-10-12' })).toMatchObject({ due_date: '2026-10-12T12:00:00Z', recurrence: 'FREQ=WEEKLY', due_all_day: true });
    expect(await call(w, 'update_task', { task_id: task.id, recurrence: 'FREQ=MONTHLY' })).toMatchObject({ due_date: '2026-10-12T12:00:00Z', recurrence: 'FREQ=MONTHLY', due_all_day: true });
  }));

  it('reopens a done task for status pending, alone or with other fields, without touching a deferral', async () => withWorld(async w => {
    const task = await call(w, 'add_task', { title: 'T' });
    await call(w, 'complete_task', { task_id: task.id });
    expect(await call(w, 'update_task', { task_id: task.id, status: 'pending', title: 'Back' })).toMatchObject({ status: 'pending', title: 'Back' });
    await call(w, 'defer_task', { task_id: task.id, kind: 'someday' });
    expect(await call(w, 'update_task', { task_id: task.id, status: 'pending' })).toMatchObject({ defer_kind: 'someday' });
  }));
});

describe('IDs that cannot name an entity', () => {
  it('are "not found" for task verbs, not an internal validation error', async () => withWorld(async w => {
    for (const [name, args] of [['complete_task', { task_id: 'nope' }], ['focus_task', { task_id: '' }]] as const)
      await expect(call(w, name, args), name).rejects.toMatchObject({ detail: { code: 'not_found' } });
    expect(rows(w, 'command_receipts')).toHaveLength(0);
  }));
});
