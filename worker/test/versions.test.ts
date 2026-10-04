import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DB } from '../src/db';
import { applyPlan, checkPlanCapacity, readEntityVersion } from '../src/storage/apply';
import type { Plan } from '../src/domain/Op';
import { parseEntityKey, parseEntityVersionResponse, entityStorageKey } from '@shared/wire/versions';
import { parseRevision, parseTaskId } from '@shared/parse';
import { handleApiRequest } from '../src/api';
import { sqliteD1 } from './helpers/sqliteD1';

const stamp = '2026-10-01T10:00:00.123Z';
const taskInsert = (id = 't_first1') => `INSERT INTO tasks(id,title,created_at,updated_at) VALUES('${id}','Original','${stamp}','${stamp}')`;
function key(input: unknown) {
  const parsed = parseEntityKey(input);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
  return parsed.value;
}
const taskKey = key({ entity: 'task', id: 't_first1' });
function revision(n: number) {
  const parsed = parseRevision(n);
  if (!parsed.ok) throw new Error();
  return parsed.value;
}
const taskId = parseTaskId('t_first1');
if (!taskId.ok) throw new Error();
const id = taskId.value;
const patchPlan = (expected: number | null): Plan => ({
  assertions: [{ kind: 'entity.revision', key: taskKey, expected: expected === null ? null : revision(expected) }],
  ops: [{ kind: 'task.update', id, patch: { title: 'Planned' } }],
});

it('backfills zero revisions without editing historical rows and does not reset on schema reinstallation', () => {
  const sql = new DatabaseSync(':memory:');
  try {
    const dir = fileURLToPath(new URL('../migrations/', import.meta.url));
    for (const name of readdirSync(dir).filter(name => name.endsWith('.sql') && name < '011').sort()) sql.exec(readFileSync(`${dir}/${name}`, 'utf8'));
    sql.exec(taskInsert());
    sql.exec(`INSERT INTO projects(id,title,created_at,updated_at) VALUES('p_first1','Project','${stamp}','${stamp}');
      ${taskInsert('t_other1')}; INSERT INTO task_links VALUES('t_first1','t_other1','blocks');
      INSERT INTO duties(id,title,rrule,dtstart,created_at,updated_at) VALUES('d_first1','Duty','FREQ=DAILY','${stamp}','${stamp}','${stamp}')`);
    const before = sql.prepare('SELECT * FROM tasks').all();
    sql.exec(readFileSync(`${dir}/011_entity_versions.sql`, 'utf8'));
    expect(sql.prepare('SELECT * FROM tasks').all()).toEqual(before);
    expect(sql.prepare('SELECT entity,revision,deleted_at FROM entity_versions').all()).toEqual([
      { entity: 'task', revision: 0, deleted_at: null }, { entity: 'task', revision: 0, deleted_at: null },
      { entity: 'project', revision: 0, deleted_at: null }, { entity: 'link', revision: 0, deleted_at: null }, { entity: 'duty', revision: 0, deleted_at: null },
    ]);
    sql.exec("UPDATE tasks SET title='New' WHERE id='t_first1'");
    sql.exec(readFileSync(fileURLToPath(new URL('../schema.sql', import.meta.url)), 'utf8'));
    expect(sql.prepare("SELECT revision FROM entity_versions WHERE entity='task' AND entity_key='t_first1'").get()).toMatchObject({ revision: 1 });
    expect(sql.prepare('SELECT structural_revision FROM workspace_versions').get()).toMatchObject({ structural_revision: 1 });
  } finally { sql.close(); }
});

describe.each(['fresh', 'upgrade'] as const)('revision ledger (%s)', mode => {
  it('tracks every raw row transition and retains monotonic identity across delete/recreate', async () => {
    const { sql, d1 } = sqliteD1(mode);
    try {
      expect(await readEntityVersion(d1, taskKey)).toMatchObject({ version: null, structuralRevision: 0 });
      sql.exec(taskInsert());
      expect(await readEntityVersion(d1, taskKey)).toMatchObject({ version: { revision: 1, deletedAt: null }, structuralRevision: 1 });
      // Equal timestamps and even a SQL no-op never mask a committed writer.
      sql.exec("UPDATE tasks SET title=title WHERE id='t_first1'");
      expect(await readEntityVersion(d1, taskKey)).toMatchObject({ version: { revision: 2 }, structuralRevision: 2 });
      sql.exec("DELETE FROM tasks WHERE id='t_first1'");
      const tombstone = await readEntityVersion(d1, taskKey);
      expect(tombstone.version?.revision).toBe(3);
      expect(tombstone.version?.deletedAt).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
      expect(parseEntityVersionResponse(tombstone).ok).toBe(true);
      sql.exec(taskInsert());
      expect(await readEntityVersion(d1, taskKey)).toMatchObject({ version: { revision: 4, deletedAt: null }, structuralRevision: 4 });
      sql.exec("DELETE FROM tasks WHERE id='missing'");
      expect(await readEntityVersion(d1, taskKey)).toMatchObject({ structuralRevision: 4 });
    } finally { sql.close(); }
  });
  it.each([0, 1])('tracks FK link cascades with recursive_triggers=%s', async recursive => {
    const { sql, d1 } = sqliteD1(mode);
    try {
      sql.exec(`PRAGMA recursive_triggers=${recursive}; ${taskInsert()}; ${taskInsert('t_other1')}; INSERT INTO task_links VALUES('t_first1','t_other1','blocks')`);
      const linkKey = key({ entity: 'link', from: 't_first1', to: 't_other1', linkType: 'blocks' });
      expect(entityStorageKey(linkKey)).toBe('["t_first1","t_other1","blocks"]');
      sql.exec("DELETE FROM tasks WHERE id='t_first1'");
      expect(await readEntityVersion(d1, linkKey)).toMatchObject({ structuralRevision: 5, version: { revision: 2 } });
      expect((await readEntityVersion(d1, linkKey)).version?.deletedAt).not.toBeNull();
      sql.exec(`${taskInsert()}; INSERT INTO task_links VALUES('t_first1','t_other1','blocks')`);
      expect(await readEntityVersion(d1, linkKey)).toMatchObject({ structuralRevision: 7, version: { revision: 3, deletedAt: null } });
    } finally { sql.close(); }
  });
  it('tracks project/duty changes and rejects primary-key moves', async () => {
    const { sql, d1 } = sqliteD1(mode);
    try {
      sql.exec(`INSERT INTO projects(id,title,created_at,updated_at) VALUES('p_first1','Project','${stamp}','${stamp}');
        INSERT INTO duties(id,title,rrule,dtstart,created_at,updated_at) VALUES('d_first1','Duty','FREQ=DAILY','${stamp}','${stamp}','${stamp}');
        ${taskInsert()}; ${taskInsert('t_other1')}; INSERT INTO task_links VALUES('t_first1','t_other1','blocks')`);
      for (const query of ["UPDATE tasks SET id='t_new111'", "UPDATE projects SET id='p_new111'", "UPDATE duties SET id='d_new111'", "UPDATE task_links SET link_type='related'"]) {
        expect(() => sql.exec(query)).toThrow('immutable');
      }
      sql.exec("UPDATE projects SET title='Edited'; UPDATE duties SET status='paused'; DELETE FROM projects; DELETE FROM duties");
      for (const k of [key({ entity: 'project', id: 'p_first1' }), key({ entity: 'duty', id: 'd_first1' })]) {
        expect((await readEntityVersion(d1, k)).version).toMatchObject({ revision: 3 });
        expect((await readEntityVersion(d1, k)).version?.deletedAt).not.toBeNull();
      }
    } finally { sql.close(); }
  });
});

it('tracks real legacy Drizzle, Plan, bulk detach, recurrence and v1 restore writers', async () => {
  const { d1, sql } = sqliteD1();
  const db = new DB(d1);
  try {
    const first = await db.addTask({ title: 'Daily', due_date: '2026-10-01', recurrence: 'FREQ=DAILY' });
    const second = await db.addTask({ title: 'Other' });
    const firstKey = key({ entity: 'task', id: first.id });
    expect((await db.getEntityVersion(firstKey)).version?.revision).toBe(1);
    await db.updateTask(first.id, { notes: 'Updated', defer_kind: 'someday' });
    const project = await db.createProject({ title: 'Project' }, [first.id, second.id]);
    await db.updateProject(project.id, { notes: 'Updated' });
    await db.linkTasks(first.id, second.id, 'blocks');
    const completed = await db.completeTask(first.id);
    expect(completed?.next).toBeDefined();
    expect((await db.getEntityVersion(firstKey)).version?.revision).toBe(4);
    expect((await db.getEntityVersion(key({ entity: 'task', id: completed!.next!.id }))).version?.revision).toBe(1);
    await db.deleteProject(project.id);
    expect((await db.getEntityVersion(firstKey)).version?.revision).toBe(5);
    expect((await db.getEntityVersion(key({ entity: 'project', id: project.id }))).version?.deletedAt).not.toBeNull();
    await db.unlinkTasks(first.id, second.id, 'blocks');
    const before = await db.exportAll();
    await db.importAll(before, false);
    expect((await db.getEntityVersion(firstKey)).version).toEqual({ revision: 7, deletedAt: null });
    await db.deleteTask(first.id);
    expect((await db.getEntityVersion(firstKey)).version?.revision).toBe(8);
  } finally { sql.close(); }
});

it.each(['entity', 'structure', 'absent', 'deleted'])('rejects a raced %s guard in the batch without committing planned writes', async scenario => {
  const { sql, d1, hooks } = sqliteD1();
  try {
    if (scenario !== 'absent') sql.exec(taskInsert());
    const plan = scenario === 'structure' ? { ...patchPlan(1), assertions: [{ kind: 'workspace.structural_revision' as const, expected: revision(1) }] } : patchPlan(scenario === 'absent' ? null : 1);
    hooks.beforeBatch = () => {
      if (scenario === 'structure') sql.exec(taskInsert('t_phantom'));
      else if (scenario === 'absent') sql.exec(taskInsert());
      else if (scenario === 'deleted') sql.exec("DELETE FROM tasks WHERE id='t_first1'");
      else sql.exec("UPDATE tasks SET title='Winner' WHERE id='t_first1'");
    };
    // For the absent race, task.update's existence precheck would fail before
    // the hook. Use a second unrelated insert as the proposed mutation.
    if (scenario === 'absent') plan.ops = [{ kind: 'project.insert', row: { id: 'p_fresh1', title: 'Planned', notes: null, kickoff_note: null, status: 'active', created_at: stamp, updated_at: stamp } }];
    expect(await applyPlan(d1, plan)).toMatchObject({ ok: false });
    expect(sql.prepare("SELECT * FROM projects WHERE id='p_fresh1'").get()).toBeUndefined();
    expect(sql.prepare("SELECT * FROM tasks WHERE title='Planned'").all()).toEqual([]);
    expect((await readEntityVersion(d1, taskKey)).structuralRevision).toBe(scenario === 'absent' ? 1 : 2);
  } finally { sql.close(); }
});
it('does not mistake a tombstone for an ID that never existed', async () => {
  const { sql, d1, batches } = sqliteD1();
  try {
    sql.exec(`${taskInsert()}; DELETE FROM tasks`);
    expect(await applyPlan(d1, patchPlan(null))).toMatchObject({ ok: false, error: { kind: 'conflict' } });
    expect(batches).toEqual([]);
  } finally { sql.close(); }
});
it('rolls back trigger versions/tombstones with a late batch failure', async () => {
  const { sql, d1, hooks } = sqliteD1();
  try {
    sql.exec(taskInsert());
    hooks.failAfter = 3;
    const plan = patchPlan(1);
    plan.ops.push({ kind: 'task.delete', id });
    expect(await applyPlan(d1, plan)).toMatchObject({ ok: false, error: { kind: 'storage' } });
    expect(await readEntityVersion(d1, taskKey)).toMatchObject({ structuralRevision: 1, version: { revision: 1, deletedAt: null } });
    expect(sql.prepare('SELECT title FROM tasks').get()).toMatchObject({ title: 'Original' });
  } finally { sql.close(); }
});
it.each(['entity', 'workspace'])('fails closed on %s revision exhaustion and rolls the row change back', async which => {
  const { sql, d1 } = sqliteD1();
  try {
    sql.exec(taskInsert());
    sql.exec(which === 'entity' ? 'UPDATE entity_versions SET revision=9007199254740991' : 'UPDATE workspace_versions SET structural_revision=9007199254740991');
    expect(() => sql.exec("UPDATE tasks SET title='Overflow'")).toThrow('Revision exhausted');
    expect(sql.prepare('SELECT title FROM tasks').get()).toMatchObject({ title: 'Original' });
    expect((await readEntityVersion(d1, taskKey)).version?.revision).toBe(which === 'entity' ? Number.MAX_SAFE_INTEGER : 1);
  } finally { sql.close(); }
});
it.each(['INSERT OR REPLACE', 'UPDATE OR IGNORE'])('does not let an outer %s writer bypass revision exhaustion', query => {
  const { sql } = sqliteD1();
  try {
    sql.exec(taskInsert());
    sql.exec('UPDATE workspace_versions SET structural_revision=9007199254740991');
    const writer = query === 'UPDATE OR IGNORE' ? "UPDATE OR IGNORE tasks SET title='Bypass'" : taskInsert().replace('INSERT', 'INSERT OR REPLACE').replace('Original', 'Bypass');
    expect(() => sql.exec(writer)).toThrow('Revision exhausted');
    expect(sql.prepare('SELECT title FROM tasks').get()).toMatchObject({ title: 'Original' });
    expect(sql.prepare('SELECT revision FROM entity_versions').get()).toMatchObject({ revision: 1 });
  } finally { sql.close(); }
});
it.each([0, 1])('keeps replacement ledger revisions increasing with recursive_triggers=%s', recursive => {
  const { sql } = sqliteD1();
  try {
    sql.exec(`PRAGMA recursive_triggers=${recursive}; ${taskInsert()}`);
    sql.exec(taskInsert().replace('INSERT', 'INSERT OR REPLACE'));
    const current = sql.prepare('SELECT revision FROM entity_versions').get()!.revision as number;
    expect(current).toBeGreaterThan(1);
    expect(sql.prepare('SELECT structural_revision FROM workspace_versions').get()).toMatchObject({ structural_revision: current });
  } finally { sql.close(); }
});
it('counts aggregate/entity guard SQL before any I/O or mutation', async () => {
  const { sql, d1, reads, batches } = sqliteD1();
  try {
    const plan: Plan = { ...patchPlan(1), assertions: [...patchPlan(1).assertions, { kind: 'workspace.structural_revision', expected: revision(1) }] };
    expect(checkPlanCapacity(d1, plan)).toMatchObject({ ok: true, value: { requiredStatements: 4 } });
    plan.assertions.push(...Array.from({ length: 97 }, () => plan.assertions[0]!));
    expect(await applyPlan(d1, plan)).toMatchObject({ ok: false, error: { kind: 'capacity_exceeded', requiredStatements: 101 } });
    expect(reads()).toBe(0); expect(batches).toEqual([]);
  } finally { sql.close(); }
});

describe('version lookup boundaries', () => {
  it('returns coherent parsed results over REST', async () => {
    const { sql, d1 } = sqliteD1();
    const db = new DB(d1);
    try {
      sql.exec(taskInsert());
      const req = new Request('https://test/api/v2/entity-version', { method: 'POST', body: JSON.stringify(taskKey) });
      const rest = await handleApiRequest(req, new URL(req.url), db);
      const body = await rest.json();
      expect(rest.status).toBe(200); expect(parseEntityVersionResponse(body).ok).toBe(true);
    } finally { sql.close(); }
  });
  it.each([{}, { entity: 'task', id: 'invalid' }, { entity: 'task', id, extra: true }, { entity: 'link', from: id, to: id }, { entity: 'link', from: id, to: id, linkType: 'unknown' }])('rejects malformed input before reading', async input => {
    const { sql, d1, reads } = sqliteD1();
    try {
      const req = new Request('https://test/api/v2/entity-version', { method: 'POST', body: JSON.stringify(input) });
      expect((await handleApiRequest(req, new URL(req.url), new DB(d1))).status).toBe(400);
      expect(reads()).toBe(0);
    } finally { sql.close(); }
  });
});
