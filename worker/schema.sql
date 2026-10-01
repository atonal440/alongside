-- Projects must exist before tasks can reference them
CREATE TABLE IF NOT EXISTS projects (
  id           TEXT PRIMARY KEY,   -- nanoid, e.g. "p_x7k2m"
  title        TEXT NOT NULL,
  notes        TEXT,
  kickoff_note TEXT,
  status       TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'archived'
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- A duty is a recurring series' anchor: rrule + dtstart + timezone define its
-- occurrence calendar and are immutable after creation (reschedule/re-zone is
-- end_duty + create_duty). last_spawned_at is a monotonic cursor;
-- next_occurrence_at drives the due-gate. See docs/plans/duties.md.
CREATE TABLE IF NOT EXISTS duties (
  id                 TEXT PRIMARY KEY,   -- nanoid, e.g. "d_x7k2m"
  title              TEXT NOT NULL,
  notes              TEXT,
  kickoff_note       TEXT,
  task_type          TEXT NOT NULL DEFAULT 'action',  -- 'action' | 'plan'
  project_id         TEXT REFERENCES projects(id),
  rrule              TEXT NOT NULL,      -- series RRULE (COUNT/UNTIL/time-capable)
  dtstart            TEXT NOT NULL,      -- UTC datetime, minute resolution; immutable
  timezone           TEXT,               -- optional IANA anchor zone; null = expand in UTC; immutable
  status             TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'paused' | 'ended'
  catch_up           TEXT NOT NULL DEFAULT 'next',    -- 'next' | 'all'
  last_spawned_at    TEXT,               -- cursor; null = none yet
  next_occurrence_at TEXT,               -- next un-spawned occurrence; drives the due-gate
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS duties_next_occurrence_at ON duties(next_occurrence_at);

CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,   -- nanoid, e.g. "t_x7k2m"
  title         TEXT NOT NULL,
  notes         TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'done'
  due_date      TEXT,               -- UTC datetime, minute resolution, nullable (Decision 4)
  due_all_day   INTEGER,            -- explicit all-day marker (0/1), nullable; NULL treated as all-day (true)
  recurrence    TEXT,               -- iCal RRULE string, nullable (legacy; superseded by duties)
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  defer_until   TEXT,               -- nullable, ISO 8601 (only meaningful when defer_kind = 'until')
  defer_kind    TEXT NOT NULL DEFAULT 'none',  -- 'none' | 'until' | 'someday'
  task_type     TEXT NOT NULL DEFAULT 'action',  -- 'action' | 'plan'
  project_id    TEXT REFERENCES projects(id),
  kickoff_note  TEXT,               -- re-entry ramp: what to do next, not a summary
  session_log   TEXT,               -- appended at session close: what happened, decisions made
  focused_until TEXT,               -- ISO 8601 timestamp; task is "focused" while now < this value
  duty_id       TEXT REFERENCES duties(id),  -- set together with occurrence_at, null together
  occurrence_at TEXT                -- UTC datetime; the duty occurrence this task instance is
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);
CREATE UNIQUE INDEX IF NOT EXISTS tasks_duty_occurrence ON tasks(duty_id, occurrence_at);

-- Horizontal dependency graph between tasks
CREATE TABLE IF NOT EXISTS task_links (
  from_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  to_task_id   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  link_type    TEXT NOT NULL,
  -- 'blocks'  : from_task must complete before to_task can start
  -- 'related' : informational, no scheduling implication
  PRIMARY KEY (from_task_id, to_task_id, link_type)
);

-- User preferences (written conversationally, not via settings UI)
CREATE TABLE IF NOT EXISTS user_preferences (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Append-only log of every CRUD operation; title is denormalized at write time
-- so entries survive task/project deletion and are identical on every device.
CREATE TABLE IF NOT EXISTS action_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tool_name  TEXT NOT NULL,
  task_id    TEXT,
  duty_id    TEXT,
  title      TEXT NOT NULL,
  detail     TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code           TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  expires_at     INTEGER NOT NULL
);

-- Additive foundation only. Do not reinterpret legacy task due values here.
-- No settings are inferred from the deployer's host timezone.
CREATE TABLE planning_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  timezone TEXT NOT NULL,
  buffer_minutes INTEGER NOT NULL DEFAULT 0 CHECK (typeof(buffer_minutes) = 'integer' AND buffer_minutes BETWEEN 0 AND 1440),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (typeof(revision) = 'integer' AND revision >= 0 AND revision <= 9007199254740991),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE planning_working_hours (
  settings_id INTEGER NOT NULL REFERENCES planning_settings(id) ON DELETE CASCADE CHECK (settings_id = 1),
  weekday INTEGER NOT NULL CHECK (typeof(weekday) = 'integer' AND weekday BETWEEN 1 AND 7),
  start_time TEXT NOT NULL CHECK (start_time GLOB '[0-2][0-9]:[0-5][0-9]' AND start_time < '24:00'),
  end_time TEXT NOT NULL CHECK (end_time GLOB '[0-2][0-9]:[0-5][0-9]' AND end_time < '24:00' AND end_time > start_time),
  PRIMARY KEY (settings_id, weekday, start_time)
);

-- ── Migrations for existing databases ─────────────────────────────────────────
-- Run these manually if upgrading from a previous schema version.
-- Safe to ignore errors on fresh installs (columns already present).
--
-- v3: add focused_until for time-decaying task focus
-- ALTER TABLE tasks ADD COLUMN focused_until TEXT;
-- UPDATE tasks SET focused_until = datetime('now', '+3 hours'), status = 'pending' WHERE status = 'active';
--
-- v2: streamline schema
-- ALTER TABLE projects ADD COLUMN notes TEXT;
-- UPDATE tasks SET task_type = 'action' WHERE task_type = 'recurring';
-- DELETE FROM task_links WHERE link_type = 'supersedes';
-- UPDATE tasks SET session_id = NULL;
-- DROP INDEX IF EXISTS idx_tasks_session_id;
--
-- v1: add task metadata
-- ALTER TABLE tasks ADD COLUMN task_type    TEXT NOT NULL DEFAULT 'action';
-- ALTER TABLE tasks ADD COLUMN project_id   TEXT REFERENCES projects(id);
-- ALTER TABLE tasks ADD COLUMN kickoff_note TEXT;
-- ALTER TABLE tasks ADD COLUMN session_log  TEXT;
--
-- CREATE TABLE IF NOT EXISTS action_log (
--   id INTEGER PRIMARY KEY AUTOINCREMENT, tool_name TEXT NOT NULL, task_id TEXT,
--   title TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL
-- );
