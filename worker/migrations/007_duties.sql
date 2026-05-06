-- v7: Introduce duties — schedule-driven task templates that materialize into
-- real tasks on a schedule. Replaces the prior completion-driven recurrence
-- (where marking a recurring task done auto-created the next instance) so
-- accidental completion no longer shifts the schedule. Existing recurring
-- tasks are migrated by 008_recurring_tasks_to_duties.sql.
CREATE TABLE IF NOT EXISTS duties (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  notes           TEXT,
  kickoff_note    TEXT,
  task_type       TEXT NOT NULL DEFAULT 'action',
  project_id      TEXT REFERENCES projects(id),
  recurrence      TEXT NOT NULL,
  due_offset_days INTEGER NOT NULL DEFAULT 0,
  active          INTEGER NOT NULL DEFAULT 1,
  next_fire_at    TEXT NOT NULL,
  last_fired_at   TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_duties_active_next_fire ON duties(active, next_fire_at);

ALTER TABLE tasks ADD COLUMN duty_id TEXT REFERENCES duties(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN duty_fire_at TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_duty_fire ON tasks(duty_id, duty_fire_at);
