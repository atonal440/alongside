import { describe, expect, it } from 'vitest';
import { DB } from '../src/db';
import { parseCommandEnvelope, parseChangesPreview, parseChangesResult } from '@shared/wire/commands';
import { parseEntityReadKey } from '@shared/wire/versions';
import { sqliteD1 } from './helpers/sqliteD1';
import { handleApiRequest } from '../src/api';
import { handleMcpRequest } from '../src/mcp';
import { parseFoundationErrorEnvelope } from '@shared/wire/planning';

function input(entity: 'task' | 'project', id: string, rev = 1, commandId = 'c_content1') {
  const parsed = parseCommandEnvelope({ contractVersion: 2, commandId, actor: 'user', commands: [{ kind: `${entity}.content.set`, id,
    expectedRevision: rev, values: { title: 'Edited', notes: null, kickoffNote: 'Next start', ...(entity === 'task' ? { sessionLog: 'Session notes' } : {}) },
  }] });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
  return parsed.value;
}
function key(entity: 'task' | 'project', id: string) {
  const parsed = parseEntityReadKey({ entity, id });
  if (!parsed.ok) throw new Error();
  return parsed.value;
}
async function setup(entity: 'task' | 'project', mode: 'fresh' | 'upgrade' = 'fresh') {
  const fixture = sqliteD1(mode);
  const db = new DB(fixture.d1);
  const row = entity === 'task' ? await db.addTask({ title: 'Original', notes: 'Old notes', due_date: '2026-10-05', recurrence: 'FREQ=WEEKLY', task_type: 'plan' }) : await db.createProject({ title: 'Original', notes: 'Old notes' });
  return { ...fixture, db, row, input: input(entity, row.id) };
}
describe.each(['fresh', 'upgrade'] as const)('content commands (%s)', mode => {
  it.each(['task', 'project'] as const)('previews and commits %s text with versioned before/after and audit/feed', async entity => {
    const { sql, db, row, input: envelope, batches } = await setup(entity, mode);
    try {
      const baselineBatches = [...batches];
      const before = await db.getEntitySnapshot(key(entity, row.id));
      expect(await db.previewChanges(envelope)).toMatchObject({ dryRun: true, requiredStatements: 6, refs: {}, changes: [{ before: { revision: 1 }, after: { revision: 2, row: { title: 'Edited', notes: null } } }] });
      expect(parseChangesPreview(await db.previewChanges(envelope)).ok).toBe(true);
      expect(await db.getEntitySnapshot(key(entity, row.id))).toEqual(before);
      expect(batches).toEqual(baselineBatches);
      const result = await db.applyChanges(envelope);
      expect(parseChangesResult(result).ok).toBe(true);
      expect(result).toMatchObject({ changes: [{ before: { row: { title: 'Original' }, revision: 1 }, after: { row: { title: 'Edited', notes: null, kickoff_note: 'Next start', created_at: before.row!.created_at }, revision: 2 } }] });
      const after = await db.getEntitySnapshot(key(entity, row.id));
      expect(after.version?.revision).toBe(2);
      const managed = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([name]) => !['title','notes','kickoff_note','session_log','updated_at'].includes(name)));
      expect(managed(after.row!)).toEqual(managed(before.row!));
      if (entity === 'task') expect(after.row).toMatchObject({ due_date: '2026-10-05T12:00:00Z', due_all_day: true, recurrence: 'FREQ=WEEKLY', task_type: 'plan', status: 'pending', session_log: 'Session notes' });
      else expect(after.row).toMatchObject({ status: 'active' });
      expect(sql.prepare('SELECT changes_json FROM command_audit').get()).toMatchObject({ changes_json: JSON.stringify(result.changes) });
      expect(sql.prepare('SELECT revision FROM change_feed').get()).toMatchObject({ revision: 2 });
    } finally { sql.close(); }
  });
});
it.each(['task', 'project'] as const)('replays a lost %s edit response after later legacy edits and deletion', async entity => {
  const { sql, db, row, input: envelope, hooks } = await setup(entity);
  try {
    hooks.loseResponse = true;
    const first = await db.applyChanges(envelope);
    if (entity === 'task') await db.updateTask(row.id, { notes: 'Later' });
    else await db.updateProject(row.id, { notes: 'Later' });
    expect(await db.applyChanges(envelope)).toEqual(first);
    sql.exec(`DELETE FROM ${entity === 'task' ? 'tasks' : 'projects'}`);
    expect(await db.applyChanges(envelope)).toEqual(first);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM command_receipts').get()).toMatchObject({ n: 1 });
    await expect(db.applyChanges(input(entity, row.id, 2, 'c_content1'))).rejects.toMatchObject({ detail: { code: 'command_id_conflict' } });
  } finally { sql.close(); }
});
it.each(['legacy-edit', 'delete', 'identical'])('closes a raced task content command (%s)', async race => {
  const { sql, db, row, input: envelope, hooks } = await setup('task');
  try {
    let winner: unknown;
    hooks.beforeBatch = async () => {
      if (race === 'identical') winner = await db.applyChanges(envelope);
      else if (race === 'delete') await db.deleteTask(row.id);
      else await db.updateTask(row.id, { notes: 'Winner' });
    };
    if (race === 'identical') expect(await db.applyChanges(envelope)).toEqual(winner);
    else {
      await expect(db.applyChanges(envelope)).rejects.toMatchObject({ detail: { code: 'revision_conflict', currentEntity: { version: { revision: 2 } } } });
      expect(sql.prepare('SELECT * FROM command_receipts').all()).toEqual([]);
      expect(sql.prepare('SELECT * FROM command_audit').all()).toEqual([]);
      expect(sql.prepare('SELECT * FROM change_feed').all()).toEqual([]);
    }
  } finally { sql.close(); }
});
it('allows unrelated concurrent edits while preserving their structural revision', async () => {
  const { sql, db, row, input: envelope, hooks } = await setup('task');
  try {
    const other = await db.addTask({ title: 'Unrelated' });
    hooks.beforeBatch = async () => { await db.updateTask(other.id, { notes: 'Concurrent' }); };
    expect(await db.applyChanges(envelope)).toMatchObject({ changes: [{ after: { revision: 2 } }] });
    expect((await db.getEntitySnapshot(key('task', row.id))).structuralRevision).toBe(4);
  } finally { sql.close(); }
});
it.each([4, 5])('rolls back content, receipt, versions and audit/feed on late failure %s', async failAfter => {
  const { sql, db, row, input: envelope, hooks } = await setup('task');
  try {
    hooks.failAfter = failAfter;
    await expect(db.applyChanges(envelope)).rejects.toMatchObject({ detail: { code: 'storage_unavailable' } });
    expect((await db.getEntitySnapshot(key('task', row.id))).row?.title).toBe('Original');
    expect((await db.getEntitySnapshot(key('task', row.id))).version?.revision).toBe(1);
    for (const table of ['command_receipts', 'command_audit', 'change_feed']) expect(sql.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
  } finally { sql.close(); }
});
it.each(['entity', 'workspace'])('reports %s exhaustion before writing', async which => {
  const { sql, db, row, batches } = await setup('task');
  try {
    sql.exec(which === 'entity' ? "UPDATE entity_versions SET revision=9007199254740991 WHERE entity='task'" : 'UPDATE workspace_versions SET structural_revision=9007199254740991');
    await expect(db.applyChanges(input('task', row.id, which === 'entity' ? Number.MAX_SAFE_INTEGER : 1))).rejects.toMatchObject({ detail: { code: 'revision_exhausted', retryable: false } });
    expect(batches).toEqual([]);
  } finally { sql.close(); }
});
it('exposes shared content results through REST and MCP and structured conflicts', async () => {
  const { sql, d1, db, row, input: envelope } = await setup('project');
  try {
    const req = new Request('https://test/api/v2/changes', { method: 'POST', body: JSON.stringify(envelope) });
    const response = await handleApiRequest(req, new URL(req.url), db);
    const result = await response.json(); expect(parseChangesResult(result).ok).toBe(true);
    const rpc = new Request('https://test/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'apply_changes', arguments: envelope } }) });
    expect(await (await handleMcpRequest(rpc, db, { DB: d1, AUTH_TOKEN: 'test' })).json()).toMatchObject({ result: { structuredContent: result } });
    const stale = new Request('https://test/api/v2/changes', { method: 'POST', body: JSON.stringify(input('project', row.id, 1, 'c_stale11')) });
    const conflict = await handleApiRequest(stale, new URL(stale.url), db);
    expect(conflict.status).toBe(409); expect(parseFoundationErrorEnvelope(await conflict.json()).ok).toBe(true);
  } finally { sql.close(); }
});
it.each(['status', 'project_id', 'recurrence', 'due_date', 'focused_until', 'defer_kind', 'taskType'])('rejects managed content field %s', field => {
  const envelope = input('task', 't_first1');
  expect(parseCommandEnvelope({ ...envelope, commands: [{ ...envelope.commands[0], values: { ...envelope.commands[0]!.values, [field]: 'managed' } }] }).ok).toBe(false);
});

it.each(['task', 'project'] as const)('preserves terminal/archived state during %s content edits', async entity => {
  const { sql, db, row } = await setup(entity);
  try {
    sql.exec(entity === 'task' ? "UPDATE tasks SET status='done'" : "UPDATE projects SET status='archived'");
    expect(await db.applyChanges(input(entity, row.id, 2))).toMatchObject({ changes: [{ after: { row: { status: entity === 'task' ? 'done' : 'archived' }, revision: 3 } }] });
  } finally { sql.close(); }
});
it('returns durable exhaustion if an unrelated writer consumes the final aggregate revision in the race window', async () => {
  const { sql, db, row, input: envelope, hooks } = await setup('task');
  try {
    hooks.beforeBatch = () => { sql.exec('UPDATE workspace_versions SET structural_revision=9007199254740991'); };
    await expect(db.applyChanges(envelope)).rejects.toMatchObject({ detail: { code: 'revision_exhausted', retryable: false } });
    expect((await db.getEntitySnapshot(key('task', row.id))).row?.title).toBe('Original');
    expect(sql.prepare('SELECT * FROM command_receipts').all()).toEqual([]);
  } finally { sql.close(); }
});
