import { describe, expect, it } from 'vitest';
import type { Task } from '@shared/types';
import { parseIsoDateTimeMinute } from '@shared/parse';
import type { Plan } from '../../src/domain/Op';
import { applyPlan } from '../../src/storage/apply';
import { sqliteD1 } from '../helpers/sqliteD1';

function instant(source: string) {
  const parsed = parseIsoDateTimeMinute(source);
  if (!parsed.ok) throw new Error('Invalid fixture.');
  return parsed.value;
}
const first = instant('2026-01-01T09:00:00Z');
const second = instant('2026-01-02T09:00:00Z');
const third = instant('2026-01-03T09:00:00Z');

function task(id: string, occurrence: string): Task {
  return {
    id, title: 'Water plants', notes: 'Keep this history', status: 'pending',
    due_date: occurrence, due_all_day: false, recurrence: null,
    created_at: occurrence, updated_at: occurrence, defer_until: null,
    defer_kind: 'none', task_type: 'action', project_id: null,
    kickoff_note: 'Check soil', session_log: null, focused_until: null,
    duty_id: 'd_demo1', occurrence_at: occurrence, available_from: null, deadline: null, parent_id: null, position: null,
  };
}
function plan(id: string, occurrence: typeof first, next: typeof first): Plan {
  return { assertions: [], ops: [
    { kind: 'task.insert', row: task(id, occurrence) },
    { kind: 'duty.update_cursor', id: 'd_demo1', lastSpawnedAt: occurrence, nextOccurrenceAt: next, updatedAt: occurrence },
  ] };
}
function setup() {
  const fixture = sqliteD1();
  fixture.sql.prepare(`INSERT INTO duties(id,title,rrule,dtstart,next_occurrence_at,created_at,updated_at)
    VALUES('d_demo1','Water plants','FREQ=DAILY',?,?,?,?)`).run(first, first, first, first);
  return fixture;
}

describe('atomic duty materialization execution', () => {
  it('inserts a bounded backlog before advancing both cursor fields in the same batch', async () => {
    const { d1, sql } = setup();
    try {
      const backlog: Plan = { assertions: [], ops: [
        { kind: 'task.insert', row: task('t_first', first) },
        { kind: 'task.insert', row: task('t_second', second) },
        { kind: 'duty.update_cursor', id: 'd_demo1', lastSpawnedAt: second, nextOccurrenceAt: null, updatedAt: third },
      ] };
      expect((await applyPlan(d1, backlog)).ok).toBe(true);
      expect(sql.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toMatchObject({ n: 2 });
      await applyPlan(d1, plan('t_replay', second, third));
      expect(sql.prepare('SELECT last_spawned_at,next_occurrence_at FROM duties').get()).toEqual({ last_spawned_at: second, next_occurrence_at: null });
      expect(sql.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toMatchObject({ n: 2 });
    } finally { sql.close(); }
  });

  it('rejects an older insert after a newer plan commits, as well as duplicate replays', async () => {
    const { d1, sql } = setup();
    try {
      expect((await applyPlan(d1, plan('t_newer', second, third))).ok).toBe(true);
      expect((await applyPlan(d1, plan('t_older', first, second))).ok).toBe(true);
      expect((await applyPlan(d1, plan('t_retry', second, third))).ok).toBe(true);
      expect(sql.prepare('SELECT id,occurrence_at FROM tasks').all()).toEqual([{ id: 't_newer', occurrence_at: second }]);
      expect(sql.prepare('SELECT last_spawned_at,next_occurrence_at FROM duties').get()).toEqual({ last_spawned_at: second, next_occurrence_at: third });
    } finally { sql.close(); }
  });

  it('retains historical opens and their provenance without changing due dates or user state', async () => {
    const { d1, sql } = setup();
    try {
      await applyPlan(d1, plan('t_first', first, second));
      sql.prepare('UPDATE tasks SET focused_until=? WHERE id=?').run(third, 't_first');
      expect((await applyPlan(d1, plan('t_second', second, third))).ok).toBe(true);
      expect(sql.prepare('SELECT * FROM tasks WHERE id=?').get('t_first')).toMatchObject({
        duty_id: 'd_demo1', occurrence_at: first, due_date: first,
        status: 'pending', defer_kind: 'none', defer_until: null, focused_until: third,
        notes: 'Keep this history', kickoff_note: 'Check soil',
      });
      await applyPlan(d1, plan('t_old_replay', first, second));
      expect(sql.prepare('SELECT id FROM tasks ORDER BY id').all()).toEqual([{ id: 't_first' }, { id: 't_second' }]);
      expect(sql.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toMatchObject({ n: 2 });
    } finally { sql.close(); }
  });

  it('handles only an occurrence conflict as a no-op and still advances the cursor', async () => {
    const { d1, sql } = setup();
    try {
      await applyPlan(d1, { assertions: [], ops: [{ kind: 'task.insert', row: task('t_existing', first) }] });
      expect((await applyPlan(d1, plan('t_duplicate', first, second))).ok).toBe(true);
      expect(sql.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toMatchObject({ n: 1 });
      expect(sql.prepare('SELECT last_spawned_at FROM duties').get()).toMatchObject({ last_spawned_at: first });
      expect((await applyPlan(d1, plan('t_existing', second, third))).ok).toBe(false);
      expect(sql.prepare('SELECT defer_kind FROM tasks').get()).toMatchObject({ defer_kind: 'none' });
      expect(sql.prepare('SELECT last_spawned_at FROM duties').get()).toMatchObject({ last_spawned_at: first });
    } finally { sql.close(); }
  });

  it.each(['paused', 'ended'])('makes writes inert when the duty becomes %s after planning', async status => {
    const { d1, sql, hooks } = setup();
    try {
      hooks.beforeBatch = () => { sql.prepare('UPDATE duties SET status=?,next_occurrence_at=NULL').run(status); };
      expect((await applyPlan(d1, plan('t_first', first, second))).ok).toBe(true);
      expect(sql.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toMatchObject({ n: 0 });
      expect(sql.prepare('SELECT last_spawned_at,next_occurrence_at FROM duties').get()).toEqual({ last_spawned_at: null, next_occurrence_at: null });
    } finally { sql.close(); }
  });

  it('does not supersede the backlog of an all duty', async () => {
    const { d1, sql } = setup();
    try {
      sql.exec("UPDATE duties SET catch_up='all'");
      await applyPlan(d1, plan('t_first', first, second));
      await applyPlan(d1, plan('t_second', second, third));
      expect(sql.prepare('SELECT defer_kind FROM tasks').all()).toEqual([{ defer_kind: 'none' }, { defer_kind: 'none' }]);
    } finally { sql.close(); }
  });

  it('rolls back insertion if the final cursor write fails', async () => {
    const { d1, sql, hooks } = setup();
    try {
      await applyPlan(d1, plan('t_first', first, second));
      hooks.failAfter = 1;
      expect((await applyPlan(d1, plan('t_second', second, third))).ok).toBe(false);
      expect(sql.prepare('SELECT id,defer_kind FROM tasks').all()).toEqual([{ id: 't_first', defer_kind: 'none' }]);
      expect(sql.prepare('SELECT last_spawned_at FROM duties').get()).toMatchObject({ last_spawned_at: first });
    } finally { sql.close(); }
  });

  it.each([{ duty_id: null }, { occurrence_at: null }])('rejects an unpaired duty instance identity %j', async patch => {
    const { d1, sql } = setup();
    try {
      for (const kind of ['task.insert', 'task.restore'] as const) {
        expect((await applyPlan(d1, { assertions: [], ops: [{ kind, row: { ...task('t_invalid', first), ...patch } }] })).ok).toBe(false);
      }
      expect(sql.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toMatchObject({ n: 0 });
    } finally { sql.close(); }
  });
});
