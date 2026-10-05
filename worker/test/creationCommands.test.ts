import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DB } from '../src/db';
import { parseCommandEnvelope, parseChangesPreview, parseChangesResult } from '@shared/wire/commands';
import { parseEntityReadKey, parseEntitySnapshot } from '@shared/wire/versions';
import { parseFoundationErrorEnvelope } from '@shared/wire/planning';
import { commandHash } from '../src/domain/commands';
import { handleApiRequest } from '../src/api';
import { handleMcpRequest } from '../src/mcp';
import { COMMAND_TOOLS } from '../src/commands';
import { sqliteD1 } from './helpers/sqliteD1';

function input(entity: 'task' | 'project', structural = 0, commandId = 'c_create1', entityId = entity === 'task' ? 't_create1' : 'p_create1', project: unknown = null) {
  const parsed = parseCommandEnvelope({ contractVersion: 2, commandId, actor: 'llm', reason: 'Capture work', commands: [{
    kind: `${entity}.create`, id: entityId, clientRef: 'newItem', expectedRevision: null, expectedStructuralRevision: structural,
    values: { title: 'Created', notes: null, kickoffNote: 'Start here', ...(entity === 'task' ? { taskType: 'action', project } : {}) },
  }] });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
  return parsed.value;
}
function key(entity: 'task' | 'project', id = entity === 'task' ? 't_create1' : 'p_create1') {
  const parsed = parseEntityReadKey({ entity, id });
  if (!parsed.ok) throw new Error();
  return parsed.value;
}

describe.each(['fresh', 'upgrade'] as const)('stable creation (%s)', mode => {
  it.each(['task', 'project'] as const)('previews and atomically creates %s with caller ID, receipt/audit/feed and ref mapping', async entity => {
    const { sql, d1, batches, reads } = sqliteD1(mode);
    const db = new DB(d1);
    try {
      const before = await db.getEntitySnapshot(key(entity));
      expect(before).toMatchObject({ row: null, version: null, structuralRevision: 0 });
      expect(reads()).toBe(1);
      const envelope = input(entity);
      const preview = await db.previewChanges(envelope);
      expect(parseChangesPreview(preview).ok).toBe(true);
      expect(preview).toMatchObject({ dryRun: true, requiredStatements: 6, refs: { newItem: key(entity).id }, changes: [{ entity, before: null, after: { revision: 1, row: { id: key(entity).id, title: 'Created' } } }] });
      expect(batches).toEqual([]);
      const result = await db.applyChanges(envelope);
      expect(parseChangesResult(result).ok).toBe(true);
      expect(batches).toEqual([6]);
      expect(sql.prepare('SELECT COUNT(*) AS n FROM command_receipts').get()).toMatchObject({ n: 1 });
      expect(sql.prepare('SELECT actor,reason FROM command_audit').get()).toMatchObject({ actor: 'llm', reason: 'Capture work' });
      const feed = sql.prepare('SELECT * FROM change_feed').get()!;
      expect(feed).toMatchObject({ seq: 1, entity, entity_id: key(entity).id, revision: 1 });
      expect(JSON.parse(feed.payload_json as string)).toEqual(result.changes[0]!.after);
      const after = await db.getEntitySnapshot(key(entity));
      expect(parseEntitySnapshot(after).ok).toBe(true);
      expect(after).toMatchObject({ row: result.changes[0]!.entity === 'planning_settings' ? {} : result.changes[0]!.after.row, version: { revision: 1, deletedAt: null }, structuralRevision: 1 });
    } finally { sql.close(); }
  });
});
it.each(['task', 'project'] as const)('returns original %s receipt after a lost response, legacy edit and deletion', async entity => {
  const { sql, d1, hooks, batches } = sqliteD1();
  const db = new DB(d1);
  try {
    hooks.loseResponse = true;
    const envelope = input(entity);
    const first = await db.applyChanges(envelope);
    sql.exec(`UPDATE ${entity === 'task' ? 'tasks' : 'projects'} SET title='Later' WHERE id='${key(entity).id}'`);
    expect(await db.applyChanges(envelope)).toEqual(first);
    sql.exec(`DELETE FROM ${entity === 'task' ? 'tasks' : 'projects'} WHERE id='${key(entity).id}'`);
    expect(await db.applyChanges(envelope)).toEqual(first);
    expect((await db.getEntitySnapshot(key(entity))).row).toBeNull();
    expect(batches).toEqual([6]);
    await expect(db.previewChanges(envelope)).rejects.toMatchObject({ detail: { code: 'already_applied' } });
    const different = input(entity, 0, 'c_create1', entity === 'task' ? 't_another' : 'p_another');
    await expect(db.applyChanges(different)).rejects.toMatchObject({ detail: { code: 'command_id_conflict' } });
  } finally { sql.close(); }
});
it.each(['task', 'project'] as const)('does not reuse a %s identity under a fresh command ID, including tombstones', async entity => {
  const { sql, d1 } = sqliteD1();
  const db = new DB(d1);
  try {
    await db.applyChanges(input(entity));
    await expect(db.applyChanges(input(entity, 1, 'c_second'))).rejects.toMatchObject({ detail: { code: 'revision_conflict', currentEntity: { version: { revision: 1 } } } });
    sql.exec(`DELETE FROM ${entity === 'task' ? 'tasks' : 'projects'}`);
    await expect(db.applyChanges(input(entity, 2, 'c_third1'))).rejects.toMatchObject({ detail: { code: 'revision_conflict', currentEntity: { row: null, version: { revision: 2 } } } });
    expect(sql.prepare('SELECT COUNT(*) AS n FROM command_receipts').get()).toMatchObject({ n: 1 });
  } finally { sql.close(); }
});
it.each(['identical', 'different', 'phantom'])('closes a concurrent creation race (%s)', async race => {
  const { sql, d1, hooks } = sqliteD1();
  const db = new DB(d1);
  try {
    const envelope = input('task');
    let winner: unknown;
    hooks.beforeBatch = async () => {
      winner = await db.applyChanges(race === 'identical' ? envelope : input('task', 0, 'c_winner', race === 'phantom' ? 't_phantom' : 't_create1'));
    };
    if (race === 'identical') expect(await db.applyChanges(envelope)).toEqual(winner);
    else await expect(db.applyChanges(envelope)).rejects.toMatchObject({ detail: { code: race === 'different' ? 'revision_conflict' : 'structural_conflict' } });
    expect(sql.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toMatchObject({ n: 1 });
    expect(sql.prepare('SELECT COUNT(*) AS n FROM command_receipts').get()).toMatchObject({ n: 1 });
  } finally { sql.close(); }
});
it('replays a receipt that commits between receipt lookup and the coherent entity read', async () => {
  const { sql, d1 } = sqliteD1();
  const db = new DB(d1);
  try {
    const envelope = input('task');
    const original = db.getEntitySnapshot.bind(db);
    let winner: unknown;
    db.getEntitySnapshot = async k => {
      db.getEntitySnapshot = original;
      winner = await db.applyChanges(envelope);
      return original(k);
    };
    expect(await db.applyChanges(envelope)).toEqual(winner);
  } finally { sql.close(); }
});
it('guards the selected project and rejects cross-snapshot structural changes', async () => {
  const { sql, d1, hooks } = sqliteD1();
  const db = new DB(d1);
  try {
    await db.applyChanges(input('project'));
    const envelope = input('task', 1, 'c_task111', 't_create1', { id: 'p_create1', expectedRevision: 1 });
    expect(await db.previewChanges(envelope)).toMatchObject({ requiredStatements: 8 });
    hooks.beforeBatch = async () => { await db.updateProject('p_create1', { notes: 'Concurrent' }); };
    await expect(db.applyChanges(envelope)).rejects.toMatchObject({ detail: { code: 'structural_conflict' } });
    expect((await db.getEntitySnapshot(key('task'))).version).toBeNull();
    const currentEnvelope = input('task', 2, 'c_task222', 't_create1', { id: 'p_create1', expectedRevision: 2 });
    const original = db.getEntitySnapshot.bind(db);
    db.getEntitySnapshot = async k => {
      const snapshot = await original(k);
      if (k.entity === 'task') { db.getEntitySnapshot = original; await db.updateProject('p_create1', { title: 'Raced' }); }
      return snapshot;
    };
    await expect(db.previewChanges(currentEnvelope)).rejects.toMatchObject({ detail: { code: 'structural_conflict' } });
    await expect(db.applyChanges(input('task', 3, 'c_task333', 't_create1', { id: 'p_create1', expectedRevision: 1 }))).rejects.toMatchObject({ detail: { code: 'revision_conflict', currentEntity: { entity: 'project' } } });
    const applied = await db.applyChanges(input('task', 3, 'c_task444', 't_create1', { id: 'p_create1', expectedRevision: 3 }));
    expect(applied).toMatchObject({ changes: [{ after: { row: { project_id: 'p_create1' } } }] });
  } finally { sql.close(); }
});
it.each([3, 4, 5])('rolls back receipt, row, versions, audit and feed on late statement failure %s', async failAfter => {
  const { sql, d1, hooks } = sqliteD1();
  try {
    hooks.failAfter = failAfter;
    await expect(new DB(d1).applyChanges(input('task'))).rejects.toMatchObject({ status: 503, detail: { code: 'storage_unavailable' } });
    for (const table of ['tasks', 'entity_versions', 'command_receipts', 'command_audit', 'change_feed']) expect(sql.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
    expect(sql.prepare('SELECT structural_revision FROM workspace_versions').get()).toMatchObject({ structural_revision: 0 });
  } finally { sql.close(); }
});
it('reports aggregate exhaustion durably before writes', async () => {
  const { sql, d1, batches } = sqliteD1();
  try {
    sql.exec('UPDATE workspace_versions SET structural_revision=9007199254740991');
    await expect(new DB(d1).applyChanges(input('task', Number.MAX_SAFE_INTEGER))).rejects.toMatchObject({ detail: { code: 'revision_exhausted', retryable: false } });
    expect(batches).toEqual([]);
  } finally { sql.close(); }
});
it.each([false, true])('preserves feed rows/allocator with removed history=%s in migration 012', removed => {
  const sql = new DatabaseSync(':memory:');
  try {
    const dir = fileURLToPath(new URL('../migrations/', import.meta.url));
    for (const name of readdirSync(dir).filter(name => name.endsWith('.sql') && name < '012').sort()) sql.exec(readFileSync(`${dir}/${name}`, 'utf8'));
    sql.exec("INSERT INTO command_receipts VALUES('c_legacy1','" + 'a'.repeat(64) + "','{}','2026-10-01T10:00:00Z'); INSERT INTO change_feed VALUES(10,'c_legacy1','planning_settings','workspace',1,'upsert','{}','2026-10-01T10:00:00Z')");
    if (removed) sql.exec('DELETE FROM change_feed');
    const before = sql.prepare('SELECT * FROM change_feed').all();
    sql.exec(readFileSync(`${dir}/012_creation_commands.sql`, 'utf8'));
    expect(sql.prepare('SELECT * FROM change_feed').all()).toEqual(before);
    sql.exec("INSERT INTO change_feed(command_id,entity,entity_id,revision,operation,payload_json,created_at) VALUES('c_legacy1','project','p_create1',1,'upsert','{}','2026-10-01T10:00:00Z')");
    expect(sql.prepare('SELECT MAX(seq) AS seq FROM change_feed').get()).toMatchObject({ seq: 11 });
  } finally { sql.close(); }
});

describe('creation/read boundaries', () => {
  it('shares REST/MCP results, parsed conflicts and coherent content reads', async () => {
    const { sql, d1 } = sqliteD1();
    const db = new DB(d1);
    try {
      const envelope = input('task');
      const req = new Request('https://test/api/v2/changes', { method: 'POST', body: JSON.stringify(envelope) });
      const rest = await handleApiRequest(req, new URL(req.url), db);
      expect(rest.status).toBe(200);
      const result = await rest.json(); expect(parseChangesResult(result).ok).toBe(true);
      const rpc = new Request('https://test/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'apply_changes', arguments: envelope } }) });
      expect(await (await handleMcpRequest(rpc, db, { DB: d1, AUTH_TOKEN: 'test' })).json()).toMatchObject({ result: { structuredContent: result } });
      const read = new Request('https://test/api/v2/entity', { method: 'POST', body: JSON.stringify(key('task')) });
      const snapshot = await (await handleApiRequest(read, new URL(read.url), db)).json();
      expect(parseEntitySnapshot(snapshot).ok).toBe(true);
      const stale = new Request('https://test/api/v2/changes', { method: 'POST', body: JSON.stringify(input('task', 1, 'c_other1')) });
      const conflict = await handleApiRequest(stale, new URL(stale.url), db);
      expect(conflict.status).toBe(409); expect(parseFoundationErrorEnvelope(await conflict.json()).ok).toBe(true);
      expect(COMMAND_TOOLS.find(tool => tool.name === 'apply_changes')?.inputSchema.properties.commands.items.oneOf).toHaveLength(20);
    } finally { sql.close(); }
  });
  it.each([
    { ...input('task'), commands: [{ ...input('task').commands[0], expectedRevision: 0 }] },
    { ...input('task'), commands: [{ ...input('task').commands[0], expectedStructuralRevision: -1 }] },
    { ...input('task'), commands: [{ ...input('task').commands[0], clientRef: '__proto__' }] },
    { ...input('task'), commands: [{ ...input('task').commands[0], values: { title: 'Created', notes: null, kickoffNote: null, taskType: 'action', project: null, status: 'done' } }] },
  ])('rejects invalid or managed create fields before reads/writes', async body => {
    const { sql, d1, reads, batches } = sqliteD1();
    try {
      const req = new Request('https://test/api/v2/changes', { method: 'POST', body: JSON.stringify(body) });
      expect((await handleApiRequest(req, new URL(req.url), new DB(d1))).status).toBe(400);
      expect(reads()).toBe(0); expect(batches).toEqual([]);
    } finally { sql.close(); }
  });
  it('normalizes title whitespace before hashing and rejects corrupt snapshot combinations', async () => {
    const first = input('task');
    const candidate = { ...first, commands: [{ ...first.commands[0], values: { ...first.commands[0]!.values, title: '  Created  ' } }] };
    const normalized = parseCommandEnvelope(candidate);
    if (!normalized.ok) throw new Error();
    expect(await commandHash(normalized.value)).toBe(await commandHash(first));
    expect(parseEntitySnapshot({ contractVersion: 2, entity: 'task', id: 't_create1', structuralRevision: 1, row: null, version: { revision: 1, deletedAt: null } }).ok).toBe(false);
  });
});
