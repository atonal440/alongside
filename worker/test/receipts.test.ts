import { describe, expect, it } from 'vitest';
import { DB } from '../src/db';
import { applyPlan } from '../src/storage/apply';
import { toolRequestHash } from '../src/domain/commands';
import { parseStoredResult, ReceiptV2Schema } from '@shared/wire/receipts';
import { parseSchema } from '@shared/parse';
import { sqliteD1 } from './helpers/sqliteD1';

const entry = (tool: string, title: string) => ({ tool_name: tool, title, detail: null });

async function committedEnvelope(db: DB, id = 'c_v1check') {
  const envelope = parseSchema((await import('@shared/wire/commands')).CommandEnvelopeSchema, {
    contractVersion: 2, commandId: id, actor: 'user',
    commands: [{ kind: 'task.create', id: 't_receip', expectedRevision: null, expectedStructuralRevision: 0, values: { title: 'T', notes: null, kickoffNote: null, taskType: 'action', project: null } }] });
  if (!envelope.ok) throw new Error(JSON.stringify(envelope.error));
  return { envelope: envelope.value, result: await db.applyChanges(envelope.value) };
}
const db2 = (d1: D1Database) => db2.cache.get(d1) ?? (db2.cache.set(d1, new DB(d1)), db2.cache.get(d1)!);
db2.cache = new WeakMap<D1Database, DB>();

describe('receipt versions', () => {
  it('stores apply_changes receipts as version 1 and replays them', async () => {
    const { sql, d1 } = sqliteD1(); const db = db2(d1);
    try {
      const { envelope, result } = await committedEnvelope(db);
      const row = sql.prepare("SELECT result_json FROM command_receipts WHERE command_id='c_v1check'").get() as { result_json: string };
      expect(JSON.parse(row.result_json).receiptVersion).toBeUndefined();
      expect(parseStoredResult(row.result_json)).toMatchObject({ ok: true, value: { receiptVersion: 1 } });
      expect(await db.applyChanges(envelope)).toEqual(result);
      await expect(db.findToolReceipt('c_v1check' as never, 'add_task', 'x')).rejects.toMatchObject({ detail: { code: 'command_id_conflict' } });
    } finally { sql.close(); }
  });

  it('replays a version 2 receipt verbatim, including after the entities it names change', async () => {
    const { sql, d1 } = sqliteD1(); const db = db2(d1);
    try {
      // A genuine result to wrap, taken while the workspace is still at structural revision 0.
      const { result } = await committedEnvelope(db);
      const a = await db.addTask({ title: 'Alpha' }); const b = await db.addTask({ title: 'Beta' });
      const hash = await toolRequestHash('link_tasks', { from_task_id: a.id, to_task_id: b.id });
      const response = { linked: true, from_task_id: a.id, from_task_title: 'Alpha', to_task_id: b.id, to_task_title: 'Beta', link_type: 'blocks', action_log_entry: entry('link_tasks', 'Alpha → Beta') };
      const applied = await applyPlan(d1, { assertions: [], ops: [{ kind: 'receipt.insert', result: { ...result, commandId: 'c_linkrep1' as never, payloadHash: hash }, stored: { tool: 'link_tasks', response } }] });
      expect(applied.ok).toBe(true);
      await db.updateTask(a.id, { title: 'Renamed' });
      const replay = await db.findToolReceipt('c_linkrep1' as never, 'link_tasks', hash);
      expect(replay?.response).toEqual(response);                 // original titles, not the renamed one
      expect(replay?.result?.commandId).toBe('c_linkrep1');
      expect(await db.findToolReceipt('c_unused01' as never, 'link_tasks', hash)).toBeNull();
      for (const [tool, requestHash] of [['unlink_tasks', hash], ['link_tasks', 'f'.repeat(64)]] as const) {
        await expect(db.findToolReceipt('c_linkrep1' as never, tool, requestHash)).rejects.toMatchObject({ detail: { code: 'command_id_conflict' } });
      }
    } finally { sql.close(); }
  });

  it('stores a no-op as a version 2 receipt with a null result and replays it', async () => {
    const { sql, d1 } = sqliteD1(); const db = db2(d1);
    try {
      const hash = await toolRequestHash('update_task', { task_id: 't_abcde', status: 'pending' });
      const response = { id: 't_abcde', action_log_entry: entry('update_task', 'x') };
      const noop = { kind: 'receipt.insert_noop' as const, commandId: 'c_noop0001' as never, payloadHash: hash, serverNow: '2026-10-03T12:00:00.000Z' as never, tool: 'update_task' as const, response };
      // The response codec is checked on read, so use a valid task response.
      const task = await db.addTask({ title: 'Noop' });
      const valid = { ...task, action_log_entry: entry('update_task', 'Noop') };
      expect((await applyPlan(d1, { assertions: [], ops: [{ ...noop, response: valid }] })).ok).toBe(true);
      const replay = await db.findToolReceipt('c_noop0001' as never, 'update_task', hash);
      expect(replay).toEqual({ response: valid, result: null });
      // The same command ID cannot be recorded twice.
      expect((await applyPlan(d1, { assertions: [], ops: [{ ...noop, response: valid }] })).ok).toBe(false);
      // An envelope on that ID conflicts rather than replaying.
      await expect(db.applyChanges(parseSchema((await import('@shared/wire/commands')).CommandEnvelopeSchema, {
        contractVersion: 2, commandId: 'c_noop0001', actor: 'user', commands: [{ kind: 'task.reopen', id: task.id, expectedRevision: 1 }] }).value as never)).rejects.toMatchObject({ detail: { code: 'command_id_conflict' } });
    } finally { sql.close(); }
  });

  it('rejects a version 2 receipt whose response does not match its tool', async () => {
    const { sql, d1 } = sqliteD1(); const db = db2(d1);
    try {
      sql.prepare('INSERT INTO command_receipts(command_id,payload_hash,result_json,created_at) VALUES(?,?,?,?)')
        .run('c_badresp1', 'a'.repeat(64), JSON.stringify({ receiptVersion: 2, tool: 'link_tasks', result: null, response: { deleted: true } }), '2026-10-03T12:00:00.000Z');
      await expect(db.findToolReceipt('c_badresp1' as never, 'link_tasks', 'a'.repeat(64))).rejects.toThrow('failed validation');
      expect(ReceiptV2Schema).toBeDefined();
      for (const bad of [{ receiptVersion: 2, tool: 'nope', result: null, response: {} }, { receiptVersion: 3, tool: 'add_task', result: null, response: {} }, { receiptVersion: 2, tool: 'update_preference', result: null, response: { updated: true, key: 'k', value: 'v', extra: 1 } }]) {
        expect(parseStoredResult(JSON.stringify(bad)).ok, JSON.stringify(bad)).toBe(false);
      }
      expect(parseStoredResult(JSON.stringify({ receiptVersion: 2, tool: 'update_preference', result: null, response: { updated: true, key: 'sort_by', value: 'due' } }))).toMatchObject({ ok: true });
    } finally { sql.close(); }
  });
});
