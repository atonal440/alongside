import { expect, it, describe } from 'vitest';
import { DB } from '../src/db';
import { parseCommandEnvelope, parseChangesResult, parseChangesPreview } from '@shared/wire/commands';
import { parseEntityReadKey } from '@shared/wire/versions';
import { parseFoundationErrorEnvelope } from '@shared/wire/planning';
import { sqliteD1 } from './helpers/sqliteD1';
import { handleApiRequest } from '../src/api';
import { handleMcpRequest } from '../src/mcp';
import { COMMAND_TOOLS } from '../src/commands';
function input(kind: string, id: string, expectedRevision = 1, fields: object = {}, commandId = 'c_state01') {
  const parsed = parseCommandEnvelope({ contractVersion: 2, commandId, actor: 'user', commands: [{ kind, id, expectedRevision, ...fields }] });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
  return parsed.value;
}
function key(entity: 'task' | 'project', id: string) {
  const parsed = parseEntityReadKey({ entity, id });
  if (!parsed.ok) throw new Error();
  return parsed.value;
}
async function setup(mode: 'fresh' | 'upgrade' = 'fresh') {
  const fixture = sqliteD1(mode); const db = new DB(fixture.d1);
  const project = await db.createProject({ title: 'Project', notes: 'Project notes', kickoff_note: 'Project kickoff' });
  const task = await db.addTask({ title: 'Task', notes: 'Task notes', project_id: project.id, due_date: '2026-10-05', recurrence: 'FREQ=WEEKLY', kickoff_note: 'Task kickoff' });
  fixture.batches.length = 0;
  return { ...fixture, db, task, project };
}
const focus = { focusedUntil: '2026-10-05T11:22:59.123-07:00' };
describe.each(['fresh', 'upgrade'] as const)('guarded state (%s)', mode => {
  it('previews without writes and atomically moves between focus and deferral with precise diffs', async () => {
    const { sql, db, task, batches } = await setup(mode);
    try {
      const envelope = input('task.focus.set', task.id, 1, focus);
      const preview = await db.previewChanges(envelope);
      expect(parseChangesPreview(preview).ok).toBe(true);
      expect(preview).toMatchObject({ requiredStatements: 6, changes: [{ before: { revision: 1, row: { focused_until: null } }, after: { revision: 2, row: { focused_until: '2026-10-05T18:22:00Z' } } }] });
      expect(batches).toEqual([]);
      const result = await db.applyChanges(envelope); expect(parseChangesResult(result).ok).toBe(true);
      const deferred = await db.applyChanges(input('task.defer.set', task.id, 2, { defer: { kind: 'until', until: '2026-10-06T10:00:39+02:00' } }, 'c_defer01'));
      expect(deferred).toMatchObject({ changes: [{ before: { revision: 2 }, after: { revision: 3, row: { defer_kind: 'until', defer_until: '2026-10-06T08:00:00Z', focused_until: null } } }] });
      const focused = await db.applyChanges(input('task.focus.set', task.id, 3, focus, 'c_focus02'));
      expect(focused).toMatchObject({ changes: [{ after: { revision: 4, row: { defer_kind: 'none', defer_until: null, focused_until: '2026-10-05T18:22:00Z' } } }] });
      const after = (await db.getEntitySnapshot(key('task', task.id))).row!;
      const preserved = (row: object) => Object.fromEntries(Object.entries(row).filter(([name]) => !['updated_at', 'defer_kind', 'defer_until', 'focused_until'].includes(name)));
      expect(preserved(after)).toEqual(preserved(task));
      expect(sql.prepare('SELECT COUNT(*) AS n FROM command_receipts').get()).toMatchObject({ n: 3 });
      expect(sql.prepare('SELECT COUNT(*) AS n FROM command_audit').get()).toMatchObject({ n: 3 });
      expect(sql.prepare('SELECT COUNT(*) AS n FROM change_feed').get()).toMatchObject({ n: 3 });
    } finally { sql.close(); }
  });
  it('archives/reopens project without changing tasks, links, membership or content', async () => {
    const { sql, db, task, project } = await setup(mode);
    try {
      const other = await db.addTask({ title: 'Other' }); await db.linkTasks(task.id, other.id, 'related');
      const beforeTask = await db.getEntitySnapshot(key('task', task.id)); const links = await db.listAllLinks();
      await db.applyChanges(input('project.archive', project.id));
      const archived = await db.getEntitySnapshot(key('project', project.id));
      expect(archived).toMatchObject({ version: { revision: 2 }, row: { status: 'archived', title: project.title, notes: project.notes, kickoff_note: project.kickoff_note } });
      await db.applyChanges(input('project.reopen', project.id, 2, {}, 'c_project2'));
      expect((await db.getEntitySnapshot(key('project', project.id))).row?.status).toBe('active');
      const afterTask = await db.getEntitySnapshot(key('task', task.id));
      expect(afterTask.row).toEqual(beforeTask.row); expect(afterTask.version).toEqual(beforeTask.version); expect(await db.listAllLinks()).toEqual(links);
    } finally { sql.close(); }
  });
});
it('clear focus retains deferral; clear deferral retains focus; someday removes old until; reopen clears attention', async () => {
  const { sql, db, task } = await setup();
  try {
    await db.deferTask(task.id, 'until', '2026-10-07T10:00:00Z');
    expect(await db.applyChanges(input('task.focus.set', task.id, 2, { focusedUntil: null }))).toMatchObject({ changes: [{ after: { row: { defer_kind: 'until', defer_until: '2026-10-07T10:00:00Z' } } }] });
    await db.applyChanges(input('task.defer.set', task.id, 3, { defer: { kind: 'someday' } }, 'c_someday'));
    expect((await db.getTask(task.id))?.defer_until).toBeNull();
    await db.applyChanges(input('task.reopen', task.id, 4, {}, 'c_reopen1'));
    expect(await db.getTask(task.id)).toMatchObject({ status: 'pending', defer_kind: 'none', focused_until: null });
    await db.applyChanges(input('task.focus.set', task.id, 5, focus, 'c_focus03'));
    await db.applyChanges(input('task.defer.set', task.id, 6, { defer: { kind: 'none' } }, 'c_clear01'));
    expect((await db.getTask(task.id))?.focused_until).toBe('2026-10-05T18:22:00Z');
  } finally { sql.close(); }
});
it('reopens completed recurrence without changing its existing successor', async () => {
  const { sql, db, task } = await setup();
  try {
    const completion = await db.completeTask(task.id); expect(completion?.next).toBeDefined();
    const successor = completion!.next!;
    await db.applyChanges(input('task.reopen', task.id, 2));
    expect(await db.getTask(successor.id)).toEqual(successor); expect(await db.listAllTasks()).toHaveLength(2);
    expect(await db.getTask(task.id)).toMatchObject({ status: 'pending', recurrence: task.recurrence, due_date: task.due_date });
  } finally { sql.close(); }
});
it.each([
  ['task.focus.set', focus, 'done'], ['task.focus.set', { focusedUntil: null }, 'done'],
  ['task.defer.set', { defer: { kind: 'none' } }, 'done'], ['task.defer.set', { defer: { kind: 'someday' } }, 'done'],
  ['task.reopen', {}, 'pending'], ['project.archive', {}, 'archived'], ['project.reopen', {}, 'active'],
])('rejects invalid %s transition from %s without a receipt', async (kind, fields, status) => {
  const { sql, db, task, project, batches } = await setup();
  try {
    const entity = kind.startsWith('task.') ? 'task' : 'project'; const id = entity === 'task' ? task.id : project.id;
    if (status === 'done' || status === 'archived') sql.prepare(`UPDATE ${entity === 'task' ? 'tasks' : 'projects'} SET status=? WHERE id=?`).run(status, id);
    const before = await db.getEntitySnapshot(key(entity, id));
    await expect(db.applyChanges(input(kind, id, before.version!.revision, fields))).rejects.toMatchObject({ status: 409, detail: { code: 'invalid_transition', retryable: false, currentEntity: before } });
    expect(await db.getEntitySnapshot(key(entity, id))).toEqual(before); expect(batches).toEqual([]);
  } finally { sql.close(); }
});
it.each(['task.focus.set', 'project.archive'])('returns original %s after lost response, later edits and deletion', async kind => {
  const { sql, db, task, project, hooks } = await setup();
  try {
    const entity = kind.startsWith('task.') ? 'task' : 'project'; const id = entity === 'task' ? task.id : project.id;
    const envelope = input(kind, id, 1, entity === 'task' ? focus : {}); hooks.loseResponse = true;
    const first = await db.applyChanges(envelope);
    sql.prepare(`UPDATE ${entity === 'task' ? 'tasks' : 'projects'} SET notes='Later' WHERE id=?`).run(id);
    expect(await db.applyChanges(envelope)).toEqual(first);
    if (entity === 'task') await db.deleteTask(id); else await db.deleteProject(id);
    expect(await db.applyChanges(envelope)).toEqual(first);
    expect(sql.prepare('SELECT COUNT(*) AS n FROM command_receipts').get()).toMatchObject({ n: 1 });
    await expect(db.applyChanges(input(kind, id, 2, entity === 'task' ? focus : {}))).rejects.toMatchObject({ detail: { code: 'command_id_conflict' } });
  } finally { sql.close(); }
});
it.each(['legacy', 'delete', 'identical', 'unrelated'])('handles in-batch race (%s)', async race => {
  const { sql, db, task, project, hooks } = await setup();
  try {
    const envelope = input('task.defer.set', task.id, 1, { defer: { kind: 'someday' } }); let winner: unknown;
    hooks.beforeBatch = async () => {
      if (race === 'legacy') await db.completeTask(task.id);
      else if (race === 'delete') await db.deleteTask(task.id);
      else if (race === 'identical') winner = await db.applyChanges(envelope);
      else await db.updateProject(project.id, { notes: 'Unrelated' });
    };
    if (race === 'identical') expect(await db.applyChanges(envelope)).toEqual(winner);
    else if (race === 'unrelated') expect(parseChangesResult(await db.applyChanges(envelope)).ok).toBe(true);
    else {
      await expect(db.applyChanges(envelope)).rejects.toMatchObject({ detail: { code: 'revision_conflict', currentEntity: { version: { revision: 2 } } } });
      for (const table of ['command_receipts', 'command_audit', 'change_feed']) expect(sql.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
    }
  } finally { sql.close(); }
});
it.each([4, 5])('rolls back state/version/receipt/audit/feed on late failure %s', async failAfter => {
  const { sql, db, task, hooks } = await setup();
  try {
    const before = await db.getEntitySnapshot(key('task', task.id)); hooks.failAfter = failAfter;
    await expect(db.applyChanges(input('task.focus.set', task.id, 1, focus))).rejects.toMatchObject({ detail: { code: 'storage_unavailable' } });
    expect(await db.getEntitySnapshot(key('task', task.id))).toEqual(before);
    for (const table of ['command_receipts', 'command_audit', 'change_feed']) expect(sql.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
  } finally { sql.close(); }
});
it.each(['entity', 'workspace', 'race'])('classifies exhaustion (%s) as durable', async which => {
  const { sql, db, task, hooks } = await setup();
  try {
    if (which === 'race') hooks.beforeBatch = () => { sql.exec('UPDATE workspace_versions SET structural_revision=9007199254740991'); };
    else sql.exec(which === 'entity' ? "UPDATE entity_versions SET revision=9007199254740991 WHERE entity='task'" : 'UPDATE workspace_versions SET structural_revision=9007199254740991');
    await expect(db.applyChanges(input('task.focus.set', task.id, which === 'entity' ? Number.MAX_SAFE_INTEGER : 1, focus))).rejects.toMatchObject({ detail: { code: 'revision_exhausted', retryable: false } });
    expect((await db.getTask(task.id))?.focused_until).toBeNull(); expect(sql.prepare('SELECT * FROM command_receipts').all()).toEqual([]);
  } finally { sql.close(); }
});
it('shares state contracts over REST/MCP, including parsed invalid-transition errors', async () => {
  const { sql, db, task, d1 } = await setup();
  try {
    const envelope = input('task.defer.set', task.id, 1, { defer: { kind: 'someday' } });
    const request = new Request('https://test/api/v2/changes', { method: 'POST', body: JSON.stringify(envelope) });
    const response = await handleApiRequest(request, new URL(request.url), db); expect(response.status).toBe(200);
    const result = await response.json(); expect(parseChangesResult(result).ok).toBe(true);
    const rpc = new Request('https://test/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'apply_changes', arguments: envelope } }) });
    expect(await (await handleMcpRequest(rpc, db, { DB: d1, AUTH_TOKEN: 'test' })).json()).toMatchObject({ result: { structuredContent: result } });
    const reopen = new Request('https://test/api/v2/changes', { method: 'POST', body: JSON.stringify(input('project.reopen', (await db.getProject(task.project_id!))!.id)) });
    const rejected = await handleApiRequest(reopen, new URL(reopen.url), db); expect(rejected.status).toBe(409); expect(parseFoundationErrorEnvelope(await rejected.json()).ok).toBe(true);
    const variants = COMMAND_TOOLS.find(tool => tool.name === 'apply_changes')!.inputSchema.properties.commands.items.oneOf;
    expect(variants.map(schema => schema.properties.kind.const)).toEqual(expect.arrayContaining(['task.focus.set', 'task.defer.set', 'task.reopen', 'project.archive', 'project.reopen']));
  } finally { sql.close(); }
});
it.each([
  ['task.focus.set', { focusedUntil: '2026-10-05' }], ['task.focus.set', { focusedUntil: undefined }],
  ['task.defer.set', { defer: { kind: 'until' } }], ['task.defer.set', { defer: { kind: 'none', until: null } }],
  ['task.defer.set', { defer: { kind: 'someday', focusedUntil: null } }], ['task.reopen', { status: 'pending' }],
  ['project.archive', { values: { status: 'archived' } }],
])('rejects invalid/managed %s input', (kind, fields) => {
  expect(parseCommandEnvelope({ contractVersion: 2, commandId: 'c_state01', actor: 'user', commands: [{ kind, id: kind.startsWith('task.') ? 't_first1' : 'p_first1', expectedRevision: 1, ...fields }] }).ok).toBe(false);
});
it('canonicalizes equivalent focus offsets/seconds before replay hashing', async () => {
  const { sql, db, task } = await setup();
  try {
    const first = await db.applyChanges(input('task.focus.set', task.id, 1, focus));
    expect(await db.applyChanges(input('task.focus.set', task.id, 1, { focusedUntil: '2026-10-05T18:22:01Z' }))).toEqual(first);
  } finally { sql.close(); }
});

it.each(['0001-01-01T00:00:00Z', '0099-12-31T23:59:00Z', '0100-01-01T00:00:00+01:00'])('rejects scheduling outside legacy row range at boundary: %s', instant => {
  for (const [kind, fields] of [['task.focus.set', { focusedUntil: instant }], ['task.defer.set', { defer: { kind: 'until', until: instant } }]] as const) {
    expect(parseCommandEnvelope({ contractVersion: 2, commandId: 'c_state01', actor: 'user', commands: [{ kind, id: 't_first1', expectedRevision: 1, ...fields }] }).ok).toBe(false);
  }
});
it.each(['0100-01-01T00:00:00Z', '9999-12-31T23:59:00Z'])('stores accepted scheduling boundary: %s', async instant => {
  const { sql, db, task } = await setup();
  try {
    const focused = await db.applyChanges(input('task.focus.set', task.id, 1, { focusedUntil: instant }));
    expect(parseChangesResult(focused).ok).toBe(true);
    const deferred = await db.applyChanges(input('task.defer.set', task.id, 2, { defer: { kind: 'until', until: instant } }, 'c_range01'));
    expect(parseChangesResult(deferred).ok).toBe(true);
    expect((await db.getTask(task.id))?.defer_until).toBe(instant);
  } finally { sql.close(); }
});
