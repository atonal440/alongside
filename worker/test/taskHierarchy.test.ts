import { describe, expect, it } from 'vitest';
import { DB } from '../src/db';
import { callCommandTool } from '../src/commands';
import { handleMcpRequest } from '../src/mcp';
import { callReadTool } from '../src/reads';
import { sqliteD1 } from './helpers/sqliteD1';
import { parseCommandEnvelope, parseChangesResult } from '@shared/wire/commands';
import { parseWorkspaceRestoreInput } from '@shared/wire/workspaceRestore';
import { hierarchyProblems, MAX_TASK_DEPTH } from '@shared/hierarchy';

const apply = (db: DB, args: unknown) => callCommandTool('apply_changes', args, db) as Promise<any>;
const base = { intent: true, contractVersion: 2, actor: 'llm' };
let n = 0;
const cid = () => `c_hier${String(++n).padStart(4, '0')}`;

async function tool(db: DB, d1: D1Database, name: string, args: unknown) {
  const request = new Request('https://t/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
  return (await (await handleMcpRequest(request, db, { DB: d1, AUTH_TOKEN: 't' }, 'default')).json()) as { result?: any; error?: any };
}
/** Run a task.parent.set through the real planner with live guards. */
async function setParent(db: DB, id: string, parentId: string | null, position: number | null = null) {
  const task = await db.getEntitySnapshot({ entity: 'task', id } as never);
  const parent = parentId === null ? null : await db.getEntitySnapshot({ entity: 'task', id: parentId } as never);
  const envelope = parseCommandEnvelope({ contractVersion: 2, commandId: cid(), actor: 'user', commands: [{ kind: 'task.parent.set', id, expectedRevision: task.version!.revision,
    expectedStructuralRevision: task.structuralRevision, parent: parent === null ? null : { id: parentId, expectedRevision: parent.version!.revision }, position }] });
  if (!envelope.ok) throw new Error(JSON.stringify(envelope.error));
  return db.applyChanges(envelope.value);
}

describe.each(['fresh', 'upgrade'] as const)('task.parent.set (%s)', mode => {
  it('nests a task, orders by position, and reaches the sync feed', async () => {
    const { sql, d1 } = sqliteD1(mode); const db = new DB(d1);
    try {
      const parent = await db.addTask({ title: 'Parent' });
      const a = await db.addTask({ title: 'A' }); const b = await db.addTask({ title: 'B' });
      const planned = await db.previewChanges(parseCommandEnvelope({ contractVersion: 2, commandId: 'c_hierpv01', actor: 'user', commands: [{ kind: 'task.parent.set', id: a.id, expectedRevision: 1, expectedStructuralRevision: (await db.getEntitySnapshot({ entity: 'task', id: a.id } as never)).structuralRevision, parent: { id: parent.id, expectedRevision: 1 }, position: 2 }] }).value as never);
      expect(planned.requiredStatements).toBe(9);   // documented in reliable-task-fields.md
      const result = await setParent(db, a.id, parent.id, 2);
      expect(parseChangesResult(result).ok).toBe(true);
      await setParent(db, b.id, parent.id, 1);
      expect(await db.getTask(a.id)).toMatchObject({ parent_id: parent.id, position: 2 });
      expect(JSON.parse(sql.prepare("SELECT row_json FROM sync_feed WHERE entity='task' AND entity_key=? ORDER BY seq DESC").get(a.id)!['row_json'] as string)).toMatchObject({ parent_id: parent.id, position: 2 });
      const context = await callReadTool('get_context', { entity: 'task', id: parent.id }, db) as any;
      expect(context.context.subtasks.map((task: any) => task.title)).toEqual(['B', 'A']);
      const child = await callReadTool('get_context', { entity: 'task', id: a.id }, db) as any;
      expect(child.context.parent.id).toBe(parent.id);
      const found = await callReadTool('find', { entity: 'task', filter: { parent_id: parent.id } }, db) as any;
      expect(found.items.map((task: any) => task.title).sort()).toEqual(['A', 'B']);
      const top = await callReadTool('find', { entity: 'task', filter: { parent_id: null } }, db) as any;
      expect(top.items.map((task: any) => task.title)).toEqual(['Parent']);
      await setParent(db, a.id, null);
      expect(await db.getTask(a.id)).toMatchObject({ parent_id: null, position: null });
    } finally { sql.close(); }
  });

  it('refuses a self parent, a loop, a different project and a chain past the limit', async () => {
    const { sql, d1 } = sqliteD1(mode); const db = new DB(d1);
    try {
      const a = await db.addTask({ title: 'A' }); const b = await db.addTask({ title: 'B' }); const c = await db.addTask({ title: 'C' });
      await expect(setParent(db, a.id, a.id)).rejects.toMatchObject({ detail: { code: 'invalid_transition' } });
      await setParent(db, b.id, a.id); await setParent(db, c.id, b.id);
      await expect(setParent(db, a.id, c.id)).rejects.toMatchObject({ detail: { code: 'invalid_transition', message: expect.stringContaining('ancestor') } });
      const project = await db.createProject({ title: 'P' } as never);
      const other = await db.addTask({ title: 'Other', project_id: project.id });
      await expect(setParent(db, other.id, a.id)).rejects.toMatchObject({ detail: { code: 'invalid_transition', message: expect.stringContaining('same project') } });
      // A chain of exactly MAX_TASK_DEPTH tasks is allowed; one more is not.
      let tail = c.id;
      for (let depth = 4; depth <= MAX_TASK_DEPTH; depth++) { const next = await db.addTask({ title: `L${depth}` }); await setParent(db, next.id, tail); tail = next.id; }
      const extra = await db.addTask({ title: 'Too deep' });
      await expect(setParent(db, extra.id, tail)).rejects.toMatchObject({ detail: { code: 'invalid_transition', message: expect.stringContaining('deep') } });
    } finally { sql.close(); }
  });

  it('guards completion, deletion and project moves around subtasks', async () => {
    const { sql, d1 } = sqliteD1(mode); const db = new DB(d1);
    try {
      const project = await db.createProject({ title: 'P' } as never);
      const parent = await db.addTask({ title: 'Parent' }); const child = await db.addTask({ title: 'Child' });
      await setParent(db, child.id, parent.id);
      const done = (id: string) => tool(db, d1, 'complete_task', { task_id: id, commandId: cid() });
      const refused = await done(parent.id);
      expect(JSON.stringify(refused)).toContain('open subtask');
      expect((await db.getTask(parent.id))!.status).toBe('pending');
      const moved = await tool(db, d1, 'update_task', { task_id: child.id, project_id: project.id, commandId: cid() });
      expect(JSON.stringify(moved)).toContain('parent');
      const movedParent = await tool(db, d1, 'update_task', { task_id: parent.id, project_id: project.id, commandId: cid() });
      expect(JSON.stringify(movedParent)).toContain('subtasks');
      const snapshot = await db.getEntitySnapshot({ entity: 'task', id: parent.id } as never);
      const remove = parseCommandEnvelope({ contractVersion: 2, commandId: cid(), actor: 'user', commands: [{ kind: 'task.delete', id: parent.id, expectedRevision: snapshot.version!.revision, expectedStructuralRevision: snapshot.structuralRevision }] });
      if (!remove.ok) throw new Error('bad envelope');
      await expect(db.applyChanges(remove.value)).rejects.toMatchObject({ detail: { code: 'invalid_transition', message: expect.stringContaining('subtask') } });
      expect(JSON.stringify(await done(child.id))).not.toContain('error');
      expect(JSON.stringify(await done(parent.id))).not.toContain('open subtask');
      expect((await db.getTask(parent.id))!.status).toBe('done');
    } finally { sql.close(); }
  });

  it('creates a subtask with add_task and moves it with update_task', async () => {
    const { sql, d1 } = sqliteD1(mode); const db = new DB(d1);
    try {
      const parent = await db.addTask({ title: 'Parent' });
      const added = await tool(db, d1, 'add_task', { title: 'Sub', parent_id: parent.id, position: 3, deadline: '2026-10-09', timezone: 'UTC', commandId: cid() });
      expect(added.error).toBeUndefined();
      const sub = JSON.parse(added.result.content[0].text);
      expect(sub).toMatchObject({ title: 'Sub', parent_id: parent.id, position: 3 });
      const other = await db.addTask({ title: 'Other' });
      await tool(db, d1, 'update_task', { task_id: sub.id, parent_id: other.id, commandId: cid() });
      expect(await db.getTask(sub.id)).toMatchObject({ parent_id: other.id, position: 3 });
      await tool(db, d1, 'update_task', { task_id: sub.id, parent_id: null, commandId: cid() });
      expect(await db.getTask(sub.id)).toMatchObject({ parent_id: null, position: null });
    } finally { sql.close(); }
  });

  it('sees earlier commands in a batch: children first, then the parent', async () => {
    const { sql, d1 } = sqliteD1(mode); const db = new DB(d1);
    try {
      const parent = await db.addTask({ title: 'Parent' }); const child = await db.addTask({ title: 'Child' });
      await setParent(db, child.id, parent.id);
      const wrongOrder = await callCommandTool('preview_changes', { ...base, commands: [{ kind: 'task.complete', id: parent.id }, { kind: 'task.complete', id: child.id }] }, db).catch((error: any) => error);
      expect(JSON.stringify(wrongOrder.detail ?? wrongOrder)).toContain('open subtask');
      const preview = await callCommandTool('preview_changes', { ...base, commands: [{ kind: 'task.complete', id: child.id }, { kind: 'task.complete', id: parent.id }] }, db) as any;
      expect(parseChangesResult(await apply(db, preview.pinnedEnvelope)).ok).toBe(true);
      expect((await db.getTask(parent.id))!.status).toBe('done');
    } finally { sql.close(); }
  });

  it('builds a parent and child in one batch with client refs', async () => {
    const { sql, d1 } = sqliteD1(mode); const db = new DB(d1);
    try {
      const preview = await callCommandTool('preview_changes', { ...base, commands: [
        { kind: 'task.create', clientRef: 'p', values: { title: 'Parent', notes: null, kickoffNote: null, taskType: 'action', project: null } },
        { kind: 'task.create', clientRef: 'c', values: { title: 'Child', notes: null, kickoffNote: null, taskType: 'action', project: null } },
        { kind: 'task.parent.set', id: '@c', parent: '@p', position: 1 },
      ] }, db) as any;
      expect(preview.pinnedEnvelope).toBeDefined();
      const result = await apply(db, preview.pinnedEnvelope);
      expect(parseChangesResult(result).ok).toBe(true);
      const tasks = await db.listAllTasks();
      const parent = tasks.find(task => task.title === 'Parent')!; const child = tasks.find(task => task.title === 'Child')!;
      expect(child).toMatchObject({ parent_id: parent.id, position: 1 });
    } finally { sql.close(); }
  });
});

describe('hierarchy in bulk documents', () => {
  const row = (id: string, parent_id: string | null, project_id: string | null = null) => ({ id, parent_id, project_id });
  it('reports a missing parent, a loop, a project mismatch and an over-deep chain', () => {
    expect(hierarchyProblems([row('t_a', null), row('t_b', 't_a'), row('t_c', 't_b')])).toEqual([]);
    expect(hierarchyProblems([row('t_a', 't_gone')])).toEqual([{ index: 0, message: expect.stringContaining('not a task') }]);
    expect(hierarchyProblems([row('t_a', 't_b'), row('t_b', 't_a')]).map(problem => problem.index)).toEqual([0, 1]);
    expect(hierarchyProblems([row('t_a', null, 'p_x'), row('t_b', 't_a', null)])).toEqual([{ index: 1, message: expect.stringContaining('same project') }]);
    const chain = Array.from({ length: MAX_TASK_DEPTH + 1 }, (_, i) => row(`t_${i}`, i === 0 ? null : `t_${i - 1}`));
    expect(hierarchyProblems(chain)).toEqual([{ index: MAX_TASK_DEPTH, message: expect.stringContaining('deep') }]);
    expect(hierarchyProblems(chain.slice(0, MAX_TASK_DEPTH))).toEqual([]);
  });

  it('restore carries hierarchy and rejects a loop', async () => {
    const { sql, d1 } = sqliteD1(); const db = new DB(d1);
    try {
      const parent = await db.addTask({ title: 'Parent' }); const child = await db.addTask({ title: 'Child' });
      await setParent(db, child.id, parent.id, 4);
      const exported = await db.exportWorkspace();
      expect(exported.tasks.find(row => row.id === child.id)).toMatchObject({ parent_id: parent.id, position: 4 });
      const cursor = sql.prepare('SELECT epoch, watermark AS sequence FROM sync_metadata').get() as { epoch: number; sequence: number };
      const make = (document: unknown) => parseWorkspaceRestoreInput({ contractVersion: 2, mode: 'apply', expectedCursor: cursor, document });
      const loop = make({ ...exported, tasks: exported.tasks.map(row => row.id === parent.id ? { ...row, parent_id: child.id } : row) });
      if (!loop.ok) throw new Error('schema should accept the document; the semantic check refuses it');
      await expect(db.restoreWorkspace(loop.value as never)).rejects.toMatchObject({ status: 400, detail: { code: 'invalid_input' } });
      const good = make(exported);
      if (!good.ok) throw new Error('unreachable');
      await db.restoreWorkspace(good.value as never);
      expect(await db.getTask(child.id)).toMatchObject({ parent_id: parent.id, position: 4 });
    } finally { sql.close(); }
  });
});
