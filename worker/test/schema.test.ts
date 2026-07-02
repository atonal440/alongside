import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
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
