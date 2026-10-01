import { describe, it, expect } from 'vitest';
import { DB } from '../src/db';
import { sqliteD1 } from './helpers/sqliteD1';
import { parseCommandEnvelope, parseChangesPreview, parseChangesResult } from '@shared/wire/commands';
import { parseEntityReadKey } from '@shared/wire/versions';
import { handleApiRequest } from '../src/api';
import { handleMcpRequest } from '../src/mcp';
import { parseFoundationErrorEnvelope } from '@shared/wire/planning';
function key(id: string) { const parsed = parseEntityReadKey({ entity: 'task', id }); if (!parsed.ok) throw new Error(); return parsed.value; }
function input(id: string, expectedRevision: number, expectedStructuralRevision: number, successor: object | null = null, commandId = 'c_complete1') {
  const parsed = parseCommandEnvelope({ contractVersion: 2, actor: 'user', commandId, commands: [{ kind: 'task.complete', id, expectedRevision, expectedStructuralRevision, successor }] });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error)); return parsed.value;
}
async function setup(recurring = true, mode: 'fresh' | 'upgrade' = 'fresh') {
  const fixture = sqliteD1(mode); const db = new DB(fixture.d1);
  const task = await db.addTask({ title: 'Original', notes: 'Notes', kickoff_note: 'Kickoff', due_date: '2026-10-05', ...(recurring ? { recurrence: 'FREQ=WEEKLY' } : {}) });
  await db.updateTask(task.id, { session_log: 'Next kickoff' }); await db.deferTask(task.id, 'someday');
  const snapshot = await db.getEntitySnapshot(key(task.id));
  const envelope = input(task.id, snapshot.version!.revision, snapshot.structuralRevision, recurring ? { id: 't_successor', clientRef: 'next' } : null);
  fixture.batches.length = 0; return { ...fixture, db, task, snapshot, envelope };
}
describe.each(['fresh', 'upgrade'] as const)('completion (%s)', mode => {
  it.each([true, false])('previews and commits recurring=%s completion with audit/feed and exact successor', async recurring => {
    const { sql, db, task, snapshot, envelope, batches } = await setup(recurring, mode);
    try {
      const preview = await db.previewChanges(envelope); expect(parseChangesPreview(preview).ok).toBe(true);
      expect(preview.requiredStatements).toBe(recurring ? 10 : 7); expect(preview.changes).toHaveLength(recurring ? 2 : 1);
      expect(await db.getEntitySnapshot(key(task.id))).toEqual(snapshot); expect(batches).toEqual([]);
      const result = await db.applyChanges(envelope); expect(parseChangesResult(result).ok).toBe(true);
      expect(result.changes[0]).toMatchObject({ entity: 'task', id: task.id, before: { row: snapshot.row, revision: 3 }, after: { revision: 4, row: { status: 'done', defer_kind: 'none', defer_until: null, focused_until: null, updated_at: result.serverNow } } });
      const after = await db.getEntitySnapshot(key(task.id)); expect(after.structuralRevision).toBe(snapshot.structuralRevision + (recurring ? 2 : 1));
      if (recurring) {
        expect(result.refs).toEqual({ next: 't_successor' });
        expect(result.changes[1]).toMatchObject({ entity: 'task', id: 't_successor', before: null, after: { revision: 1, row: { id: 't_successor', title: 'Original', notes: 'Notes', status: 'pending', due_date: '2026-10-12T12:00:00Z', due_all_day: true, recurrence: 'FREQ=WEEKLY', kickoff_note: 'Next kickoff', session_log: null, defer_kind: 'none', focused_until: null, created_at: result.serverNow } } });
        expect((await db.getEntitySnapshot(key('t_successor'))).row).toEqual(result.changes[1]!.entity === 'task' ? result.changes[1]!.after.row : {});
      } else { expect(result.refs).toEqual({}); expect(await db.listAllTasks()).toHaveLength(1); }
      expect(sql.prepare('SELECT changes_json FROM command_audit').get()).toMatchObject({ changes_json: JSON.stringify(result.changes) });
      expect(sql.prepare('SELECT entity_id,revision FROM change_feed ORDER BY seq').all()).toEqual(recurring ? [{ entity_id: task.id, revision: 4 }, { entity_id: 't_successor', revision: 1 }] : [{ entity_id: task.id, revision: 4 }]);
    } finally { sql.close(); }
  });
});
it('records successor inheritance of project/task type without copying duty occurrence identity or links', async () => {
  const { sql, db, task } = await setup();
  try {
    const project = await db.createProject({ title: 'Project' }); await db.updateTask(task.id, { project_id: project.id, task_type: 'plan' });
    const other = await db.addTask({ title: 'Other' }); await db.linkTasks(task.id, other.id, 'blocks');
    sql.exec("INSERT INTO duties(id,title,rrule,dtstart,created_at,updated_at) VALUES('d_example','Duty','FREQ=WEEKLY','2026-10-05T12:00:00Z','2026-10-01T00:00:00Z','2026-10-01T00:00:00Z')");
    sql.prepare("UPDATE tasks SET duty_id='d_example',occurrence_at='2026-10-05T12:00:00Z' WHERE id=?").run(task.id);
    const before = await db.getEntitySnapshot(key(task.id));
    const result = await db.applyChanges(input(task.id, before.version!.revision, before.structuralRevision, { id: 't_successor' }));
    expect(result.changes[1]).toMatchObject({ after: { row: { project_id: project.id, task_type: 'plan', duty_id: null, occurrence_at: null } } });
    expect(await db.getTaskLinks('t_successor')).toEqual([]); expect(await db.getTaskLinks(task.id)).toHaveLength(1);
  } finally { sql.close(); }
});
it('returns original complete+successor after lost response, subsequent changes and deletion', async () => {
  const { sql, db, task, envelope, hooks } = await setup();
  try {
    hooks.loseResponse = true; const first = await db.applyChanges(envelope);
    await db.reopenTask(task.id); await db.updateTask('t_successor', { notes: 'Changed successor' });
    expect(await db.applyChanges(envelope)).toEqual(first);
    await db.deleteTask(task.id); await db.deleteTask('t_successor'); expect(await db.applyChanges(envelope)).toEqual(first);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM command_receipts').get()).toMatchObject({ n: 1 });
    expect(await db.listAllTasks()).toEqual([]);
    await expect(db.applyChanges({ ...envelope, reason: 'Different' })).rejects.toMatchObject({ detail: { code: 'command_id_conflict' } });
  } finally { sql.close(); }
});
it.each(['task-edit', 'successor-create', 'successor-delete', 'phantom', 'identical'])('guards race (%s)', async race => {
  const { sql, db, task, envelope, hooks } = await setup();
  try {
    let winner: unknown;
    hooks.beforeBatch = async () => {
      if (race === 'identical') winner = await db.applyChanges(envelope);
      else if (race === 'task-edit') await db.updateTask(task.id, { notes: 'Winner' });
      else if (race === 'phantom') await db.addTask({ title: 'Unrelated phantom' });
      else { sql.prepare("INSERT INTO tasks(id,title,status,created_at,updated_at) SELECT ?,title,'pending',created_at,updated_at FROM tasks WHERE id=?").run('t_successor',task.id); if (race === 'successor-delete') await db.deleteTask('t_successor'); }
    };
    if (race === 'identical') { expect(await db.applyChanges(envelope)).toEqual(winner); expect(await db.listAllTasks()).toHaveLength(2); }
    else {
      await expect(db.applyChanges(envelope)).rejects.toMatchObject({ detail: { code: race === 'task-edit' ? 'revision_conflict' : 'structural_conflict' } });
      expect((await db.getTask(task.id))?.status).toBe('pending');
      for (const table of ['command_receipts','command_audit','change_feed']) expect(sql.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
    }
  } finally { sql.close(); }
});
it.each([7, 8, 9])('rolls back original, successor, ledgers, receipt and history after late failure %s', async failAfter => {
  const { sql, db, task, snapshot, envelope, hooks } = await setup();
  try {
    hooks.failAfter = failAfter; await expect(db.applyChanges(envelope)).rejects.toMatchObject({ detail: { code: 'storage_unavailable' } });
    expect(await db.getEntitySnapshot(key(task.id))).toEqual(snapshot); expect(await db.getEntitySnapshot(key('t_successor'))).toMatchObject({ row: null, version: null });
    for (const table of ['command_receipts','command_audit','change_feed']) expect(sql.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
  } finally { sql.close(); }
});
it.each(['live', 'deleted', 'self'])('rejects previously recorded successor (%s) before writes', async state => {
  const { sql, db, task, snapshot, batches } = await setup();
  try {
    let id = task.id;
    if (state !== 'self') { const existing = await db.addTask({ title: 'Existing' }); id = existing.id; if (state === 'deleted') await db.deleteTask(id); }
    const current = await db.getEntitySnapshot(key(task.id)); batches.length = 0;
    await expect(db.applyChanges(input(task.id, snapshot.version!.revision, current.structuralRevision, { id }))).rejects.toMatchObject({ detail: { code: 'revision_conflict', expectedRevision: null, currentEntity: { id } } });
    expect(batches).toEqual([]); expect((await db.getTask(task.id))?.status).toBe('pending');
  } finally { sql.close(); }
});
it.each([true,false])('rejects mismatched successor shape recurring=%s', async recurring => {
  const { sql, db, task, snapshot, batches } = await setup(recurring);
  try {
    await expect(db.applyChanges(input(task.id, snapshot.version!.revision, snapshot.structuralRevision, recurring ? null : { id: 't_successor' }))).rejects.toMatchObject({ status: 400, detail: { code: 'invalid_input', path: ['commands','0','successor'] } });
    expect(batches).toEqual([]);
  } finally { sql.close(); }
});
it('requires pending status and retains replay even when now done', async () => {
  const { sql, db, task, envelope } = await setup();
  try {
    const result = await db.applyChanges(envelope); expect(await db.applyChanges(envelope)).toEqual(result);
    const current = await db.getEntitySnapshot(key(task.id));
    await expect(db.applyChanges(input(task.id, current.version!.revision, current.structuralRevision, { id: 't_another' }, 'c_again001'))).rejects.toMatchObject({ detail: { code: 'invalid_transition', currentEntity: current } });
    expect(await db.listAllTasks()).toHaveLength(2);
  } finally { sql.close(); }
});
it.each(['entity', 'workspace'])('rejects revision exhaustion (%s) before partial completion', async kind => {
  const { sql, db, task } = await setup();
  try {
    if (kind === 'entity') sql.prepare("UPDATE entity_versions SET revision=9007199254740991 WHERE entity='task' AND entity_key=?").run(task.id);
    else sql.exec('UPDATE workspace_versions SET structural_revision=9007199254740990');
    const current = await db.getEntitySnapshot(key(task.id));
    await expect(db.applyChanges(input(task.id, current.version!.revision, current.structuralRevision, { id: 't_successor' }))).rejects.toMatchObject({ detail: { code: 'revision_exhausted', retryable: false } });
    expect((await db.getTask(task.id))?.status).toBe('pending'); expect((await db.getEntitySnapshot(key('t_successor'))).version).toBeNull();
  } finally { sql.close(); }
});
it('shares compound completion results and structured errors over REST/MCP', async () => {
  const { sql, db, d1, envelope, task } = await setup();
  try {
    const req = new Request('https://test/api/v2/changes', { method: 'POST', body: JSON.stringify(envelope) }); const response = await handleApiRequest(req,new URL(req.url),db);
    const result = await response.json(); expect(response.status).toBe(200); expect(parseChangesResult(result).ok).toBe(true);
    const rpc = new Request('https://test/mcp',{ method: 'POST', body: JSON.stringify({ jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'apply_changes',arguments:envelope} }) });
    expect(await (await handleMcpRequest(rpc,db,{DB:d1,AUTH_TOKEN:'test'})).json()).toMatchObject({result:{structuredContent:result}});
    const stale = new Request('https://test/api/v2/changes', { method:'POST',body:JSON.stringify({...envelope,commandId:'c_stale001'}) });
    const rejected = await handleApiRequest(stale,new URL(stale.url),db); expect(rejected.status).toBe(409);expect(parseFoundationErrorEnvelope(await rejected.json()).ok).toBe(true);
    expect((await db.getTask(task.id))?.status).toBe('done');
  } finally { sql.close(); }
});
it.each([{ successor: undefined },{ successor:{id:'t_successor',clientRef:'constructor'} },{ completedAt:'2026-10-01T12:00:00Z' },{ expectedStructuralRevision:undefined }])('rejects incomplete or managed completion input', patch => {
  expect(parseCommandEnvelope({contractVersion:2,commandId:'c_complete1',actor:'user',commands:[{kind:'task.complete',id:'t_first1',expectedRevision:1,expectedStructuralRevision:1,successor:null,...patch}]}).ok).toBe(false);
});
