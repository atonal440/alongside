import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { DB } from '../src/db';
import { handleMcpRequest } from '../src/mcp';
import { callCommandTool } from '../src/commands';
import { ChangesResultSchema, CommandEnvelopeSchema } from '@shared/wire/commands';
import { parseSchema } from '@shared/parse';
import { sqliteD1 } from './helpers/sqliteD1';

type World = ReturnType<typeof sqliteD1>;
const withWorld = async (fn: (w: World, db: DB) => Promise<void>) => { const w = sqliteD1(); try { await fn(w, new DB(w.d1)); } finally { w.sql.close(); } };
async function tool(w: World, name: string, args: Record<string, unknown>) {
  const request = new Request('https://t/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  const body = await (await handleMcpRequest(request, new DB(w.d1), { DB: w.d1, AUTH_TOKEN: 't' })).json() as any;
  if (body.error) throw new Error(body.error.message);
  if (body.result.isError) throw Object.assign(new Error(body.result.content[0].text), { detail: body.result.structuredContent.error });
  return body.result.structuredContent as any;
}
const envelope = (commandId: string, command: Record<string, unknown>) => {
  const parsed = parseSchema(CommandEnvelopeSchema, { contractVersion: 2, commandId, actor: 'user', commands: [{ kind: 'preference.set', ...command }] });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
  return parsed.value;
};
const pref = (w: World, key: string) => w.sql.prepare('SELECT value FROM user_preferences WHERE key=?').get(key) as { value: string } | undefined;
const logs = (w: World) => (w.sql.prepare('SELECT COUNT(*) AS n FROM action_log').get() as { n: number }).n;

describe('preference.set command', () => {
  it('sets a new preference, records a before/after diff, and replays', async () => withWorld(async (w, db) => {
    const input = envelope('c_pref0001', { key: 'sort_by', value: 'due', expectedRevision: null });
    const preview = await db.previewChanges(input);
    expect(preview.changes[0]).toMatchObject({ entity: 'preference', id: 'sort_by', before: null, after: { revision: 1, value: 'due' } });
    expect(pref(w, 'sort_by')).toBeUndefined();                           // a preview writes nothing
    const result = await db.applyChanges(input);
    expect(v.safeParse(ChangesResultSchema, result).success).toBe(true);
    expect(pref(w, 'sort_by')?.value).toBe('due');
    expect(await db.applyChanges(input)).toEqual(result);
    expect(w.sql.prepare("SELECT COUNT(*) AS n FROM command_audit").get()).toEqual({ n: 1 });
    expect(w.sql.prepare("SELECT revision FROM sync_aux_versions WHERE entity='preference' AND entity_key='sort_by'").get()).toEqual({ revision: 1 });
  }));

  it('steps the revision by one and refuses a stale or wrong guard', async () => withWorld(async (w, db) => {
    await db.applyChanges(envelope('c_pref0002', { key: 'sort_by', value: 'due', expectedRevision: null }));
    const second = await db.applyChanges(envelope('c_pref0003', { key: 'sort_by', value: 'project', expectedRevision: 1 }));
    expect(second.changes[0]).toMatchObject({ before: { revision: 1, value: 'due' }, after: { revision: 2, value: 'project' } });
    await expect(db.applyChanges(envelope('c_pref0004', { key: 'sort_by', value: 'due', expectedRevision: 1 }))).rejects.toMatchObject({ detail: { code: 'revision_conflict' } });
    await expect(db.applyChanges(envelope('c_pref0005', { key: 'sort_by', value: 'due', expectedRevision: null }))).rejects.toMatchObject({ detail: { code: 'revision_conflict' } });
    await expect(db.applyChanges(envelope('c_pref0006', { key: 'urgency_visibility', value: 'hide', expectedRevision: 3 }))).rejects.toMatchObject({ detail: { code: 'revision_conflict' } });
    expect(pref(w, 'sort_by')?.value).toBe('project');
  }));

  it('guards the commit against a write between planning and the batch', async () => withWorld(async (w, db) => {
    await db.applyChanges(envelope('c_pref0007', { key: 'sort_by', value: 'due', expectedRevision: null }));
    const input = envelope('c_pref0008', { key: 'sort_by', value: 'project', expectedRevision: 1 });
    w.hooks.beforeBatch = () => { w.sql.prepare("UPDATE user_preferences SET value='readiness' WHERE key='sort_by'").run(); };
    await expect(db.applyChanges(input)).rejects.toMatchObject({ detail: { code: 'revision_conflict' } });
    expect(pref(w, 'sort_by')?.value).toBe('readiness');
  }));

  it('validates the value for its key and refuses unknown keys', async () => withWorld(async (_w, db) => {
    await expect(db.previewChanges(envelope('c_pref0009', { key: 'sort_by', value: 'colour', expectedRevision: null }))).rejects.toMatchObject({ detail: { code: 'invalid_input' } });
    expect(parseSchema(CommandEnvelopeSchema, { contractVersion: 2, commandId: 'c_pref0010', actor: 'user', commands: [{ kind: 'preference.set', key: 'favourite', value: 'x', expectedRevision: null }] }).ok).toBe(false);
  }));

  it('stays standalone: it cannot join a mixed batch', async () => {
    const mixed = parseSchema(CommandEnvelopeSchema, { contractVersion: 2, commandId: 'c_pref0011', actor: 'user', expectedStructuralRevision: 0, commands: [
      { kind: 'preference.set', key: 'sort_by', value: 'due', expectedRevision: null },
      { kind: 'task.create', id: 't_prefmx1', expectedRevision: null, expectedStructuralRevision: 0, values: { title: 'T', notes: null, kickoffNote: null, taskType: 'action', project: null } }] });
    expect(mixed.ok).toBe(false);
  });

  it('is available through preview_changes loose intent and describe_commands', async () => withWorld(async (w, db) => {
    const preview = await callCommandTool('preview_changes', { intent: true, contractVersion: 2, commands: [{ kind: 'preference.set', key: 'sort_by', value: 'due' }] }, db) as any;
    expect(preview.pinnedEnvelope.commands[0]).toMatchObject({ kind: 'preference.set', expectedRevision: null });
    await callCommandTool('apply_changes', preview.pinnedEnvelope, db);
    expect(pref(w, 'sort_by')?.value).toBe('due');
    const described = await tool(w, 'describe_commands', { family: 'preference' });
    expect(parseSchema(CommandEnvelopeSchema, described.example).ok).toBe(true);
  }));
});

describe('update_preference', () => {
  it('replays, never logs, and stores a version 2 receipt with the preference diff', async () => withWorld(async w => {
    const first = await tool(w, 'update_preference', { key: 'sort_by', value: 'due', commandId: 'c_upref001' });
    expect(first).toEqual({ updated: true, key: 'sort_by', value: 'due' });
    expect(await tool(w, 'update_preference', { key: 'sort_by', value: 'due', commandId: 'c_upref001' })).toEqual(first);
    await tool(w, 'update_preference', { key: 'sort_by', value: 'project' });
    expect(await tool(w, 'update_preference', { key: 'sort_by', value: 'due', commandId: 'c_upref001' })).toEqual(first);   // original, not current
    expect(pref(w, 'sort_by')?.value).toBe('project');
    expect(logs(w)).toBe(0);
    const stored = JSON.parse((w.sql.prepare("SELECT result_json FROM command_receipts WHERE command_id='c_upref001'").get() as any).result_json);
    expect(stored).toMatchObject({ receiptVersion: 2, tool: 'update_preference', response: first, result: { changes: [{ entity: 'preference' }] } });
    await expect(tool(w, 'update_preference', { key: 'sort_by', value: 'readiness', commandId: 'c_upref001' })).rejects.toMatchObject({ detail: { code: 'command_id_conflict' } });
  }));

  it('retries a lost race by default and honours a pinned revision, including null for never set', async () => withWorld(async w => {
    w.hooks.beforeBatch = () => { w.sql.prepare("INSERT INTO user_preferences(key,value) VALUES('sort_by','readiness')").run(); };
    expect(await tool(w, 'update_preference', { key: 'sort_by', value: 'due' })).toMatchObject({ updated: true });   // won on retry
    expect(pref(w, 'sort_by')?.value).toBe('due');
    await expect(tool(w, 'update_preference', { key: 'sort_by', value: 'project', expectedRevision: null })).rejects.toMatchObject({ detail: { code: 'revision_conflict' } });
    await expect(tool(w, 'update_preference', { key: 'sort_by', value: 'project', expectedRevision: 99 })).rejects.toMatchObject({ detail: { code: 'revision_conflict' } });
    expect(await tool(w, 'update_preference', { key: 'urgency_visibility', value: 'hide', expectedRevision: null })).toMatchObject({ updated: true });
  }));

  it('refuses a bad key, a bad value and a missing value without writing', async () => withWorld(async w => {
    for (const args of [{ key: 'nope', value: 'x' }, { key: 'sort_by', value: 'colour' }, { key: 'sort_by' }, { value: 'due' }]) {
      await expect(tool(w, 'update_preference', args)).rejects.toMatchObject({ detail: { code: 'invalid_input' } });
    }
    expect(w.sql.prepare('SELECT COUNT(*) AS n FROM user_preferences').get()).toEqual({ n: 0 });
    expect(w.sql.prepare('SELECT COUNT(*) AS n FROM command_receipts').get()).toEqual({ n: 0 });
  }));
});
