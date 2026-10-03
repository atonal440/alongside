import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { DB } from '../src/db';
import { CommandEnvelopeSchema, ChangesResultSchema, ChangesPreviewSchema } from '@shared/wire/commands';
import { parseSchema } from '@shared/parse';
import { sqliteD1 } from './helpers/sqliteD1';

/**
 * Build an envelope against the workspace's current structural revision. Commands are written with
 * expectedStructuralRevision 0 (or none); this fills in the live value.
 */
async function env(db: DB, commands: unknown[], commandId: string) {
  const structural = (await db.getEntitySnapshot({ entity: 'task', id: 't_probe00' } as never)).structuralRevision;
  const filled = commands.map(c => 'expectedStructuralRevision' in (c as object) ? { ...(c as object), expectedStructuralRevision: structural } : c);
  const parsed = parseSchema(CommandEnvelopeSchema, { contractVersion: 2, commandId, actor: 'llm', ...(commands.length > 1 ? { expectedStructuralRevision: structural } : {}), commands: filled });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
  return parsed.value;
}
const create = (id: string) => ({ kind: 'task.create', id, expectedRevision: null, expectedStructuralRevision: 0, values: { title: 'Task', notes: null, kickoffNote: null, taskType: 'action', project: null } });
const schedule = (id: string, expectedRevision: number) => ({ kind: 'task.legacy-schedule.set', id, expectedRevision, values: { dueDate: '2026-11-02', dueAllDay: true, recurrence: 'FREQ=WEEKLY' } });
const content = (id: string, expectedRevision: number, values: Record<string, unknown>) => ({ kind: 'task.content.set', id, expectedRevision, values: { title: 'Task', notes: null, kickoffNote: null, sessionLog: null, ...values } });
const del = (id: string, expectedRevision: number) => ({ kind: 'task.delete', id, expectedRevision, expectedStructuralRevision: 0 });
const link = (kind: string, rev: number | null) => ({ kind, from: 't_aaaaaa', to: 't_bbbbbb', linkType: 'blocks', expectedRevision: rev, expectedStructuralRevision: 0 });
const count = (sql: ReturnType<typeof sqliteD1>['sql'], table: string) => (sql.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
const revision = (sql: ReturnType<typeof sqliteD1>['sql'], id: string) => sql.prepare("SELECT revision FROM entity_versions WHERE entity='task' AND entity_key=?").get(id);

describe('same-identity composition', () => {
  it('creates a dated recurring task as one atomic change with one receipt', async () => {
    const { sql, d1 } = sqliteD1(); const db = new DB(d1);
    try {
      const input = await env(db, [create('t_dated1'), schedule('t_dated1', 1)], 'c_compose1');
      const preview = await db.previewChanges(input);
      expect(v.safeParse(ChangesPreviewSchema, preview).success).toBe(true);
      expect(preview.changes).toHaveLength(1);
      expect(preview.commandChanges).toEqual([[0], [0]]);
      expect(preview.changeGroups).toBeUndefined();
      const result = await db.applyChanges(input);
      expect(v.safeParse(ChangesResultSchema, result).success).toBe(true);
      expect(result.changes[0]).toMatchObject({ entity: 'task', id: 't_dated1', before: null, after: { revision: 1, row: { due_date: '2026-11-02T12:00:00Z', due_all_day: true, recurrence: 'FREQ=WEEKLY' } } });
      expect(await db.getTask('t_dated1')).toMatchObject({ due_date: '2026-11-02T12:00:00Z', recurrence: 'FREQ=WEEKLY', title: 'Task' });
      expect(revision(sql, 't_dated1')).toEqual({ revision: 1 });
      expect([count(sql, 'command_receipts'), count(sql, 'command_audit'), count(sql, 'change_feed')]).toEqual([1, 1, 1]);
      expect(await db.applyChanges(input)).toEqual(result);        // replay of a composed receipt
    } finally { sql.close(); }
  });

  it('applies title and due date to an existing task with one revision step and one diff', async () => {
    const { sql, d1 } = sqliteD1(); const db = new DB(d1);
    try {
      await db.applyChanges(await env(db, [create('t_multi01')], 'c_seed0001'));
      const result = await db.applyChanges(await env(db, [content('t_multi01', 1, { title: 'Renamed' }), schedule('t_multi01', 2)], 'c_multi001'));
      expect(result.changes).toHaveLength(1);
      expect(result.changes[0]).toMatchObject({ before: { revision: 1, row: { title: 'Task' } }, after: { revision: 2, row: { title: 'Renamed', recurrence: 'FREQ=WEEKLY' } } });
      expect(revision(sql, 't_multi01')).toEqual({ revision: 2 });
    } finally { sql.close(); }
  });

  it('composes three commands and keeps unrelated identities separate', async () => {
    const { sql, d1 } = sqliteD1(); const db = new DB(d1);
    try {
      const result = await db.applyChanges(await env(db, [create('t_first1'), create('t_other1'), content('t_first1', 1, { title: 'A' }), { kind: 'task.type.set', id: 't_first1', expectedRevision: 1, taskType: 'plan' }], 'c_three001'));
      expect(result.changes.map(c => c.id)).toEqual(['t_first1', 't_other1']);
      expect(result.commandChanges).toEqual([[0], [1], [0], [0]]);
      expect(await db.getTask('t_first1')).toMatchObject({ title: 'A', task_type: 'plan' });
    } finally { sql.close(); }
  });

  it('lets a task be created before the project that a later command assigns it to', async () => {
    const { sql, d1 } = sqliteD1(); const db = new DB(d1);
    try {
      const project = { kind: 'project.create', id: 'p_late01', expectedRevision: null, expectedStructuralRevision: 0, values: { title: 'P', notes: null, kickoffNote: null } };
      const assign = { kind: 'task.project.set', id: 't_early1', expectedRevision: 1, expectedStructuralRevision: 0, project: { id: 'p_late01', expectedRevision: 1 } };
      const result = await db.applyChanges(await env(db, [create('t_early1'), project, assign], 'c_order001'));
      expect(result.changes.map(c => c.id).sort()).toEqual(['p_late01', 't_early1']);
      expect((await db.getTask('t_early1'))?.project_id).toBe('p_late01');
    } finally { sql.close(); }
  });

  it('folds an edit into a later delete, and refuses create-then-delete and writes after delete', async () => {
    const { sql, d1 } = sqliteD1(); const db = new DB(d1);
    try {
      await db.applyChanges(await env(db, [create('t_gone001')], 'c_seed0002'));
      const result = await db.applyChanges(await env(db, [content('t_gone001', 1, { title: 'Doomed' }), del('t_gone001', 2)], 'c_edit0001'));
      expect(result.changes).toHaveLength(1);
      expect(result.changes[0]).toMatchObject({ before: { revision: 1 }, after: { revision: 2, deleted: true } });
      expect(await db.getTask('t_gone001')).toBeNull();
      await expect(db.previewChanges(await env(db, [create('t_born001'), del('t_born001', 1)], 'c_cd000001'))).rejects.toMatchObject({ detail: { code: 'invalid_input', path: ['commands', '1'] } });
      await db.applyChanges(await env(db, [create('t_keep001')], 'c_seed0003'));
      await expect(db.previewChanges(await env(db, [del('t_keep001', 1), content('t_keep001', 2, { title: 'Late' })], 'c_after001'))).rejects.toMatchObject({ detail: { path: expect.arrayContaining(['commands', '1']) } });
    } finally { sql.close(); }
  });

  it('still refuses a link written twice and a delete that overlaps another write', async () => {
    const { sql, d1 } = sqliteD1(); const db = new DB(d1);
    try {
      await db.applyChanges(await env(db, [create('t_aaaaaa'), create('t_bbbbbb')], 'c_seed0004'));
      await expect(db.previewChanges(await env(db, [link('link.add', null), link('link.remove', 1)], 'c_link0001'))).rejects.toMatchObject({ detail: { code: 'invalid_input' } });
      await db.applyChanges(await env(db, [link('link.add', null), create('t_cccccc')], 'c_link0002'));
      // The delete already tombstones the link as a derived effect, so a second write to it cannot be composed.
      await expect(db.previewChanges(await env(db, [del('t_aaaaaa', 1), link('link.remove', 1)], 'c_ovlp0001'))).rejects.toMatchObject({ detail: { path: expect.arrayContaining(['commands', '1']) } });
    } finally { sql.close(); }
  });

  it('rejects when the first command revision guard is stale, and when a later prediction is wrong', async () => {
    const { sql, d1 } = sqliteD1(); const db = new DB(d1);
    try {
      await db.applyChanges(await env(db, [create('t_stale01')], 'c_seed0005'));
      await db.updateTask('t_stale01', { title: 'Moved on' });                      // revision 1 -> 2
      await expect(db.applyChanges(await env(db, [content('t_stale01', 1, { title: 'X' }), schedule('t_stale01', 1)], 'c_stale001'))).rejects.toMatchObject({ detail: { code: 'revision_conflict' } });
      await expect(db.applyChanges(await env(db, [content('t_stale01', 2, { title: 'X' }), schedule('t_stale01', 2)], 'c_stale002'))).rejects.toMatchObject({ detail: { code: 'revision_conflict', path: ['commands', '1', 'expectedRevision'] } });
      expect((await db.getTask('t_stale01'))?.title).toBe('Moved on');
      expect(count(sql, 'command_receipts')).toBe(1);
      // The right prediction is the revision after the earlier commands: 2 -> 3, one step in total.
      const ok = await db.applyChanges(await env(db, [content('t_stale01', 2, { title: 'X' }), schedule('t_stale01', 3)], 'c_stale003'));
      expect(ok.changes[0]).toMatchObject({ before: { revision: 2 }, after: { revision: 3 } });
    } finally { sql.close(); }
  });

  it('turns a write that lands between planning and commit into a guard failure for the whole batch', async () => {
    const { sql, d1, hooks } = sqliteD1(); const db = new DB(d1);
    try {
      await db.applyChanges(await env(db, [create('t_race001')], 'c_seed0006'));
      const input = await env(db, [content('t_race001', 1, { title: 'Mine' }), schedule('t_race001', 2)], 'c_race0001');
      hooks.beforeBatch = () => { sql.exec("UPDATE tasks SET title='Raced' WHERE id='t_race001'"); };
      await expect(db.applyChanges(input)).rejects.toMatchObject({ detail: { code: expect.stringMatching(/^(revision|structural)_conflict$/) } });
      expect(hooks.beforeBatch).toBeUndefined();                       // the hook ran, immediately before the commit batch
      const stored = await db.getTask('t_race001');
      expect(stored?.recurrence).toBeNull();                            // none of the batch applied
      expect(stored?.title).toBe('Raced');
      expect(count(sql, 'command_receipts')).toBe(1);                   // only the seed receipt
    } finally { sql.close(); }
  });
});

describe('result contract', () => {
  async function composedResult() {
    const { sql, d1 } = sqliteD1(); const db = new DB(d1);
    try { return JSON.parse(JSON.stringify(await db.applyChanges(await env(db, [create('t_codec01'), schedule('t_codec01', 1)], 'c_codec001')))); } finally { sql.close(); }
  }
  it('accepts a composed result and rejects malformed commandChanges', async () => {
    const result = await composedResult();
    expect(v.safeParse(ChangesResultSchema, result).success).toBe(true);
    const many = Array.from({ length: 101 }, () => [0]);
    for (const commandChanges of [[[0], [1]], [[0], [0, 0]], [[1], [1]], [[0]], [[0], []], many]) {
      expect(v.safeParse(ChangesResultSchema, { ...result, commandChanges }).success, JSON.stringify(commandChanges)).toBe(false);
    }
    expect(v.safeParse(ChangesResultSchema, { ...result, changeGroups: [1, 1] }).success).toBe(false);          // both forms at once
    const { batch: _batch, ...unbatched } = result;
    expect(v.safeParse(ChangesResultSchema, unbatched).success).toBe(false);
  });
  it('keeps parsing results written before commandChanges existed', async () => {
    const { sql, d1 } = sqliteD1(); const db = new DB(d1);
    try {
      const old = JSON.parse(JSON.stringify(await db.applyChanges(await env(db, [create('t_old0001'), create('t_old0002')], 'c_old00001'))));
      expect(old.changeGroups).toEqual([1, 1]);
      expect(v.safeParse(ChangesResultSchema, old).success).toBe(true);
      const { changeGroups: _groups, ...legacy } = old;                       // the first mixed-batch release shape
      expect(v.safeParse(ChangesResultSchema, legacy).success).toBe(true);
    } finally { sql.close(); }
  });
});
