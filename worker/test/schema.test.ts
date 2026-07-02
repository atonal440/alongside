import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

// Regression coverage for worker/schema.sql — hand-written DDL that neither
// Drizzle nor `tsc` verify (docs/plans/duties/stage-1-schema-and-migration.md
// B5/B7). Runs the real reference schema against SQLite so index/constraint
// behavior is checked directly rather than only by manual `wrangler d1`
// inspection. `node:sqlite` is experimental but only used here, in tests.
function freshDb(): InstanceType<typeof DatabaseSync> {
  const schemaPath = fileURLToPath(new URL('../schema.sql', import.meta.url));
  const schema = readFileSync(schemaPath, 'utf8');
  const db = new DatabaseSync(':memory:');
  db.exec(schema);
  return db;
}

// Applies real migration files in order, up to (and excluding) `stopBefore` —
// e.g. dbFromMigrations('008_due_all_day.sql') simulates a database that has
// everything through 007 but not yet 008, for testing a migration's backfill
// against pre-existing data (which a fresh schema.sql install never has).
function dbFromMigrations(stopBefore?: string): InstanceType<typeof DatabaseSync> {
  const dir = fileURLToPath(new URL('../migrations', import.meta.url));
  const files = readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
  const db = new DatabaseSync(':memory:');
  for (const file of files) {
    if (file === stopBefore) break;
    db.exec(readFileSync(`${dir}/${file}`, 'utf8'));
  }
  return db;
}

describe('worker/schema.sql — duties (Stage 1 Part B)', () => {
  it('creates the duties table with the expected columns', () => {
    const db = freshDb();
    const columns = db.prepare('PRAGMA table_info(duties)').all().map((c) => (c as { name: string }).name);
    expect(columns).toEqual([
      'id', 'title', 'notes', 'kickoff_note', 'task_type', 'project_id',
      'rrule', 'dtstart', 'timezone', 'status', 'catch_up',
      'last_spawned_at', 'next_occurrence_at', 'created_at', 'updated_at',
    ]);
  });

  it('indexes next_occurrence_at for the due-gate', () => {
    const db = freshDb();
    const indexes = db.prepare("PRAGMA index_list('duties')").all() as { name: string }[];
    expect(indexes.some(i => i.name === 'duties_next_occurrence_at')).toBe(true);
  });

  it('adds duty_id/occurrence_at to tasks and duty_id to action_log', () => {
    const db = freshDb();
    const taskColumns = db.prepare('PRAGMA table_info(tasks)').all().map((c) => (c as { name: string }).name);
    expect(taskColumns).toContain('duty_id');
    expect(taskColumns).toContain('occurrence_at');
    const logColumns = db.prepare('PRAGMA table_info(action_log)').all().map((c) => (c as { name: string }).name);
    expect(logColumns).toContain('duty_id');
  });

  it('rejects a duplicate (duty_id, occurrence_at) pair', () => {
    const db = freshDb();
    db.exec(`
      INSERT INTO duties (id, title, rrule, dtstart, created_at, updated_at)
      VALUES ('d_1', 'Trash', 'FREQ=WEEKLY', '2026-07-01T09:00:00Z', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z');
      INSERT INTO tasks (id, title, created_at, updated_at, duty_id, occurrence_at)
      VALUES ('t_1', 'Trash A', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', 'd_1', '2026-07-01T09:00:00Z');
    `);

    expect(() => db.exec(`
      INSERT INTO tasks (id, title, created_at, updated_at, duty_id, occurrence_at)
      VALUES ('t_2', 'Trash B dup', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', 'd_1', '2026-07-01T09:00:00Z');
    `)).toThrow(/UNIQUE constraint failed/);
  });

  it('allows unlimited NULL duty_id rows (SQLite NULL-distinctness)', () => {
    const db = freshDb();
    expect(() => db.exec(`
      INSERT INTO tasks (id, title, created_at, updated_at) VALUES ('t_a', 'A', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z');
      INSERT INTO tasks (id, title, created_at, updated_at) VALUES ('t_b', 'B', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z');
    `)).not.toThrow();
  });
});

describe('worker/schema.sql — due_date is a datetime column (Stage 1 Part A)', () => {
  it('stores and round-trips a minute-resolution UTC due_date', () => {
    const db = freshDb();
    db.exec(`
      INSERT INTO tasks (id, title, created_at, updated_at, due_date)
      VALUES ('t_1', 'Water plants', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', '2026-07-15T12:00:00Z');
    `);
    const row = db.prepare('SELECT due_date FROM tasks WHERE id = ?').get('t_1') as { due_date: string };
    expect(row.due_date).toBe('2026-07-15T12:00:00Z');
  });
});

// due_all_day (codex-flagged follow-up, docs/plans/duties-implementation-todo.md
// "Notes / deviations"): explicit marker replacing the noon-UTC-instant
// heuristic, which couldn't distinguish "no time specified" from "genuinely
// due at noon UTC" once due_date was stored.
describe('worker/schema.sql — due_all_day column', () => {
  it('adds a nullable due_all_day column to tasks', () => {
    const db = freshDb();
    const columns = db.prepare('PRAGMA table_info(tasks)').all() as { name: string; notnull: number }[];
    const dueAllDay = columns.find(c => c.name === 'due_all_day');
    expect(dueAllDay).toBeDefined();
    expect(dueAllDay?.notnull).toBe(0);
  });

  it('stores explicit 0/1 and leaves it NULL when omitted', () => {
    const db = freshDb();
    db.exec(`
      INSERT INTO tasks (id, title, created_at, updated_at, due_date, due_all_day)
      VALUES ('t_timed', 'Standup', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', '2026-07-02T09:00:00Z', 0);
      INSERT INTO tasks (id, title, created_at, updated_at, due_date, due_all_day)
      VALUES ('t_allday', 'Pay rent', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', '2026-07-05T12:00:00Z', 1);
      INSERT INTO tasks (id, title, created_at, updated_at)
      VALUES ('t_legacy', 'Predates the column', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z');
    `);
    const rows = db.prepare('SELECT id, due_all_day FROM tasks ORDER BY id').all() as { id: string; due_all_day: number | null }[];
    expect(rows).toEqual([
      { id: 't_allday', due_all_day: 1 },
      { id: 't_legacy', due_all_day: null },
      { id: 't_timed', due_all_day: 0 },
    ]);
  });

  // Codex-flagged: Stage 1 (007) already let REST/MCP write a full-instant
  // due_date, so a database migrating straight from 007 to 008 can have
  // pre-existing timed due_date rows, not just noon-UTC ones. 008 must
  // backfill those as due_all_day = 0, not leave them NULL (⇒ misread as
  // all-day, masking an already-passed deadline as "Due today").
  it('008 backfills pre-existing non-noon due_date rows as due_all_day = 0', () => {
    const db = dbFromMigrations('008_due_all_day.sql');
    db.exec(`
      INSERT INTO tasks (id, title, created_at, updated_at, due_date)
      VALUES ('t_timed', 'Standup', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', '2026-07-02T09:00:00Z');
      INSERT INTO tasks (id, title, created_at, updated_at, due_date)
      VALUES ('t_allday', 'Pay rent', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', '2026-07-05T12:00:00Z');
      INSERT INTO tasks (id, title, created_at, updated_at)
      VALUES ('t_undated', 'No due date', '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z');
    `);

    db.exec(readFileSync(fileURLToPath(new URL('../migrations/008_due_all_day.sql', import.meta.url)), 'utf8'));

    const rows = db.prepare('SELECT id, due_all_day FROM tasks ORDER BY id').all() as { id: string; due_all_day: number | null }[];
    expect(rows).toEqual([
      // Ambiguous (could be all-day or coincidentally timed at noon) — left
      // NULL, read as all-day. Documented, accepted residual imprecision.
      { id: 't_allday', due_all_day: null },
      { id: 't_timed', due_all_day: 0 },
      { id: 't_undated', due_all_day: null },
    ]);
  });
});
