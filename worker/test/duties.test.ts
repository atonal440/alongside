import { describe, expect, it, vi } from 'vitest';
import type { Duty } from '@shared/types';
import { DB } from '../src/db';
import { dutyFromRow } from '../src/domain/duty';
import { callReadTool } from '../src/reads';
import { callCommandTool } from '../src/commands';
import { handleScheduled } from '../src/scheduled';
import { materializeDueDuties } from '../src/duties';
import { handleApiRequest } from '../src/api';
import { sqliteD1 } from './helpers/sqliteD1';

const at = (iso: string) => iso as never;
const duty = (over: Partial<Duty> = {}): Duty => ({
  id: 'd_daily', title: 'Water plants', notes: 'Keep this', kickoff_note: 'Check soil', task_type: 'action', project_id: null,
  rrule: 'FREQ=DAILY', dtstart: '2026-01-01T09:00:00Z', timezone: null, status: 'active', catch_up: 'next',
  last_spawned_at: null, next_occurrence_at: '2026-01-01T09:00:00Z', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', ...over,
});
function insert(sql: ReturnType<typeof sqliteD1>['sql'], row: Duty) {
  const columns = Object.keys(row);
  sql.prepare(`INSERT INTO duties(${columns.join(',')}) VALUES(${columns.map(() => '?').join(',')})`).run(...columns.map(column => (row as never)[column]));
}
const occurrences = (sql: ReturnType<typeof sqliteD1>['sql'], id = 'd_daily') =>
  sql.prepare('SELECT occurrence_at FROM tasks WHERE duty_id=? ORDER BY occurrence_at').all(id).map(row => row['occurrence_at']);
const cursor = (sql: ReturnType<typeof sqliteD1>['sql'], id = 'd_daily') =>
  sql.prepare('SELECT status,last_spawned_at,next_occurrence_at FROM duties WHERE id=?').get(id);

describe('dutyFromRow', () => {
  it('accepts a consistent duty and rejects each broken invariant', () => {
    expect(dutyFromRow(duty()).ok).toBe(true);
    expect(dutyFromRow(duty({ last_spawned_at: '2026-01-02T09:00:00Z', next_occurrence_at: '2026-01-03T09:00:00Z' })).ok).toBe(true);
    const codes = (row: Duty) => { const parsed = dutyFromRow(row); return parsed.ok ? [] : parsed.error.map(issue => issue.code); };
    expect(codes(duty({ rrule: 'FREQ=DAILY;UNTIL=20251231T000000Z' }))).toContain('until_before_dtstart');
    expect(codes(duty({ last_spawned_at: '2026-01-02T10:00:00Z', next_occurrence_at: '2026-01-03T09:00:00Z' }))).toContain('cursor_off_calendar');
    expect(codes(duty({ last_spawned_at: '2025-12-31T09:00:00Z' }))).toContain('cursor_before_dtstart');
    expect(codes(duty({ next_occurrence_at: '2026-01-05T09:00:00Z' }))).toContain('next_mismatch');
    expect(codes(duty({ status: 'ended' }))).toContain('ended_with_next');
    expect(dutyFromRow(duty({ status: 'ended', next_occurrence_at: null })).ok).toBe(true);
    expect(codes(duty({ timezone: 'Mars/Olympus' }))).toContain('timezone');
    expect(dutyFromRow(duty({ status: 'paused', last_spawned_at: '2026-01-01T09:00:00Z', next_occurrence_at: '2026-01-02T09:00:00Z' })).ok).toBe(true);
  });
});

describe('materializeDueDuties', () => {
  it('catch_up next creates only the newest due occurrence and jumps the cursor', async () => {
    const { d1, sql } = sqliteD1();
    try {
      insert(sql, duty());
      const summary = await materializeDueDuties(d1, at('2026-01-04T12:00:00Z'));
      expect(summary).toEqual({ duties: 1, instances: 1, failed: 0 });
      expect(occurrences(sql)).toEqual(['2026-01-04T09:00:00Z']);
      expect(cursor(sql)).toEqual({ status: 'active', last_spawned_at: '2026-01-04T09:00:00Z', next_occurrence_at: '2026-01-05T09:00:00Z' });
      expect(sql.prepare('SELECT * FROM tasks').get()).toMatchObject({ title: 'Water plants', notes: 'Keep this', kickoff_note: 'Check soil', due_date: '2026-01-04T09:00:00Z', status: 'pending', duty_id: 'd_daily' });
      // Running again, or from a second trigger, changes nothing.
      expect(await materializeDueDuties(d1, at('2026-01-04T12:00:00Z'))).toEqual({ duties: 0, instances: 0, failed: 0 });
      expect(occurrences(sql)).toHaveLength(1);
    } finally { sql.close(); }
  });

  it('keeps older open instances when a later occurrence arrives', async () => {
    const { d1, sql } = sqliteD1();
    try {
      insert(sql, duty());
      await materializeDueDuties(d1, at('2026-01-01T10:00:00Z'));
      sql.prepare("UPDATE tasks SET focused_until='2026-02-01T00:00:00Z' WHERE duty_id='d_daily'").run();
      await materializeDueDuties(d1, at('2026-01-02T10:00:00Z'));
      expect(occurrences(sql)).toEqual(['2026-01-01T09:00:00Z', '2026-01-02T09:00:00Z']);
      expect(sql.prepare("SELECT status,focused_until FROM tasks WHERE occurrence_at='2026-01-01T09:00:00Z'").get()).toEqual({ status: 'pending', focused_until: '2026-02-01T00:00:00Z' });
    } finally { sql.close(); }
  });

  it('catch_up all creates the backlog oldest first, a bounded batch per run', async () => {
    const { d1, sql } = sqliteD1();
    try {
      insert(sql, duty({ catch_up: 'all', rrule: 'FREQ=MINUTELY', dtstart: '2026-01-01T00:00:00Z', next_occurrence_at: '2026-01-01T00:00:00Z' }));
      const first = await materializeDueDuties(d1, at('2026-01-02T00:00:00Z'));
      expect(first.instances).toBe(50);
      expect(occurrences(sql)[0]).toBe('2026-01-01T00:00:00Z');
      expect(occurrences(sql)[49]).toBe('2026-01-01T00:49:00Z');
      expect(cursor(sql)).toMatchObject({ last_spawned_at: '2026-01-01T00:49:00Z', next_occurrence_at: '2026-01-01T00:50:00Z' });
      await materializeDueDuties(d1, at('2026-01-02T00:00:00Z'));
      expect(occurrences(sql)).toHaveLength(100);
    } finally { sql.close(); }
  });

  it('ends a finite series after its last occurrence and ignores paused duties', async () => {
    const { d1, sql } = sqliteD1();
    try {
      insert(sql, duty({ id: 'd_two', rrule: 'FREQ=DAILY;COUNT=2', catch_up: 'all' }));
      insert(sql, duty({ id: 'd_paused', status: 'paused' }));
      await materializeDueDuties(d1, at('2026-03-01T00:00:00Z'));
      expect(occurrences(sql, 'd_two')).toEqual(['2026-01-01T09:00:00Z', '2026-01-02T09:00:00Z']);
      expect(cursor(sql, 'd_two')).toEqual({ status: 'ended', last_spawned_at: '2026-01-02T09:00:00Z', next_occurrence_at: null });
      expect(occurrences(sql, 'd_paused')).toEqual([]);
      expect(cursor(sql, 'd_paused')).toMatchObject({ status: 'paused', last_spawned_at: null });
    } finally { sql.close(); }
  });

  it('keeps wall-clock time across a DST change in the anchor zone', async () => {
    const { d1, sql } = sqliteD1();
    try {
      // 09:00 in Chicago: UTC-6 in winter, UTC-5 after the March 8 change.
      insert(sql, duty({ rrule: 'FREQ=DAILY', timezone: 'America/Chicago', catch_up: 'all', dtstart: '2026-03-07T15:00:00Z', next_occurrence_at: '2026-03-07T15:00:00Z' }));
      await materializeDueDuties(d1, at('2026-03-09T20:00:00Z'));
      expect(occurrences(sql)).toEqual(['2026-03-07T15:00:00Z', '2026-03-08T14:00:00Z', '2026-03-09T14:00:00Z']);
    } finally { sql.close(); }
  });

  it('carries the latest completed instance\'s session log into the next kickoff note', async () => {
    const { d1, sql } = sqliteD1();
    try {
      insert(sql, duty());
      await materializeDueDuties(d1, at('2026-01-01T10:00:00Z'));
      sql.prepare("UPDATE tasks SET status='done', session_log='Soil was dry' WHERE duty_id='d_daily'").run();
      await materializeDueDuties(d1, at('2026-01-02T10:00:00Z'));
      expect(sql.prepare("SELECT kickoff_note FROM tasks WHERE occurrence_at='2026-01-02T09:00:00Z'").get()).toEqual({ kickoff_note: 'Soil was dry' });
    } finally { sql.close(); }
  });

  it('skips an invalid duty without blocking the others, and a replayed plan creates no duplicate', async () => {
    const { d1, sql } = sqliteD1();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      insert(sql, duty({ id: 'd_bad', next_occurrence_at: '2026-01-01T08:00:00Z' }));
      insert(sql, duty({ id: 'd_good' }));
      const summary = await materializeDueDuties(d1, at('2026-01-01T10:00:00Z'));
      expect(summary).toEqual({ duties: 1, instances: 1, failed: 1 });
      expect(occurrences(sql, 'd_good')).toHaveLength(1);
      expect(occurrences(sql, 'd_bad')).toEqual([]);
    } finally { error.mockRestore(); sql.close(); }
  });
});

describe('resilience', () => {
  it('reaches valid duties behind a full page of broken ones and survives a failing database', async () => {
    const { d1, sql } = sqliteD1();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (let index = 0; index < 205; index += 1) insert(sql, duty({ id: `d_bad${String(index).padStart(3, '0')}`, next_occurrence_at: '2026-01-01T08:00:00Z' }));
      insert(sql, duty({ id: 'd_good', next_occurrence_at: '2026-01-01T09:00:00Z' }));
      const summary = await materializeDueDuties(d1, at('2026-01-01T10:00:00Z'));
      expect(summary).toMatchObject({ duties: 1, instances: 1, failed: 205 });
      expect(occurrences(sql, 'd_good')).toHaveLength(1);
      const broken = { prepare: () => { throw new Error('D1 unavailable'); } } as unknown as D1Database;
      await expect(materializeDueDuties(broken, at('2026-01-01T10:00:00Z'))).resolves.toEqual({ duties: 0, instances: 0, failed: 1 });
    } finally { error.mockRestore(); sql.close(); }
  });
});

describe('triggers', () => {
  it('the cron handler creates due instances with no client', async () => {
    const { d1, sql } = sqliteD1();
    try {
      insert(sql, duty({ dtstart: '2020-01-01T09:00:00Z', next_occurrence_at: '2020-01-01T09:00:00Z' }));
      await handleScheduled({ DB: d1, AUTH_TOKEN: 't' });
      expect(occurrences(sql)).toHaveLength(1);
      expect(cursor(sql)).toMatchObject({ status: 'active' });
    } finally { sql.close(); }
  });

  it('list reads and sync pulls see due instances without waiting for a cron tick', async () => {
    const { d1, sql } = sqliteD1();
    try {
      const db = new DB(d1);
      insert(sql, duty({ dtstart: '2020-01-01T09:00:00Z', next_occurrence_at: '2020-01-01T09:00:00Z' }));
      const found = await callReadTool('find', { entity: 'task' }, db) as { items: { title: string; duty_id: string }[] };
      expect(found.items.map(task => task.title)).toEqual(['Water plants']);
      expect(found.items[0]!.duty_id).toBe('d_daily');
      sql.prepare('DELETE FROM tasks').run();
      sql.prepare("UPDATE duties SET last_spawned_at=NULL, next_occurrence_at='2020-01-01T09:00:00Z'").run();
      const listed = await (await handleApiRequest(new Request('https://t/api/tasks'), new URL('https://t/api/tasks'), db)).json() as unknown[];
      expect(listed).toHaveLength(1);
      sql.prepare('DELETE FROM tasks').run();
      sql.prepare("UPDATE duties SET last_spawned_at=NULL, next_occurrence_at='2020-01-01T09:00:00Z'").run();
      const snapshot = await callCommandTool('get_workspace_snapshot', {}, db);
      expect(sql.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 1 });
      expect(JSON.stringify(snapshot)).toMatch(/duty_id\\*":\\*"d_daily/);
    } finally { sql.close(); }
  });

  it('does nothing and reads nothing further when no duty is due', async () => {
    const { d1, sql } = sqliteD1();
    try {
      insert(sql, duty({ dtstart: '2999-01-01T09:00:00Z', next_occurrence_at: '2999-01-01T09:00:00Z' }));
      expect(await materializeDueDuties(d1)).toEqual({ duties: 0, instances: 0, failed: 0 });
      expect(sql.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 0 });
    } finally { sql.close(); }
  });
});
