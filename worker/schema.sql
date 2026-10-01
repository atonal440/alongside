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
CREATE TABLE IF NOT EXISTS planning_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  timezone TEXT NOT NULL,
  buffer_minutes INTEGER NOT NULL DEFAULT 0 CHECK (typeof(buffer_minutes) = 'integer' AND buffer_minutes BETWEEN 0 AND 1440),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (typeof(revision) = 'integer' AND revision >= 0 AND revision <= 9007199254740991),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS planning_working_hours (
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

-- Initial reliable command family: planning settings only. Legacy task writers
-- remain unchanged until their revisions/feed and client reconciliation land.
CREATE TABLE IF NOT EXISTS command_receipts (
  command_id TEXT PRIMARY KEY NOT NULL,
  payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS command_audit (
  command_id TEXT PRIMARY KEY NOT NULL REFERENCES command_receipts(command_id),
  actor TEXT NOT NULL CHECK (actor IN ('user','llm','import','system')),
  reason TEXT,
  changes_json TEXT NOT NULL CHECK (json_valid(changes_json)),
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS change_feed (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  command_id TEXT NOT NULL REFERENCES command_receipts(command_id),
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision BETWEEN 0 AND 9007199254740991),
  operation TEXT NOT NULL CHECK (operation = 'upsert'),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL,
  CHECK ((entity = 'planning_settings' AND entity_id = 'workspace') OR (entity = 'task' AND entity_id GLOB 't_*') OR (entity = 'project' AND entity_id GLOB 'p_*'))
);
CREATE INDEX IF NOT EXISTS change_feed_entity ON change_feed(entity, entity_id, seq);

-- Revision ledger is separate from legacy rows so old row/IDB contracts remain valid.
-- Existing live rows start at zero; only writes after installation advance it.
CREATE TABLE IF NOT EXISTS workspace_versions (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  structural_revision INTEGER NOT NULL DEFAULT 0 CHECK (typeof(structural_revision) = 'integer' AND structural_revision BETWEEN 0 AND 9007199254740991)
);
INSERT OR IGNORE INTO workspace_versions (id, structural_revision) VALUES (1, 0);
CREATE TABLE IF NOT EXISTS entity_versions (
  entity TEXT NOT NULL CHECK (entity IN ('task','project','link','duty')),
  entity_key TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision BETWEEN 0 AND 9007199254740991),
  deleted_at TEXT,
  PRIMARY KEY (entity, entity_key)
);

INSERT OR IGNORE INTO entity_versions(entity,entity_key,revision,deleted_at) SELECT 'task',id,0,NULL FROM tasks;
CREATE TRIGGER IF NOT EXISTS tasks_immutable_identity BEFORE UPDATE ON tasks
WHEN OLD.id IS NOT NEW.id
BEGIN
  SELECT RAISE(ABORT, 'Entity identity is immutable; delete/create explicitly.');
END;
CREATE TRIGGER IF NOT EXISTS tasks_version_insert AFTER INSERT ON tasks
BEGIN
  -- RAISE aborts even an outer OR IGNORE writer; its policy must not swallow
  -- revision exhaustion or a missing workspace singleton.
  SELECT RAISE(ABORT, 'Revision exhausted or workspace version missing.')
  WHERE NOT EXISTS (SELECT 1 FROM workspace_versions WHERE id=1 AND structural_revision < 9007199254740991)
    OR EXISTS (SELECT 1 FROM entity_versions WHERE entity='task' AND entity_key=NEW.id AND revision >= 9007199254740991);
  INSERT INTO entity_versions(entity,entity_key,revision,deleted_at)
  VALUES('task',NEW.id,1,NULL)
  ON CONFLICT(entity,entity_key) DO UPDATE SET revision=entity_versions.revision+1,deleted_at=excluded.deleted_at;
  UPDATE workspace_versions SET structural_revision=structural_revision+1 WHERE id=1;
END;
CREATE TRIGGER IF NOT EXISTS tasks_version_update AFTER UPDATE ON tasks
BEGIN
  -- RAISE aborts even an outer OR IGNORE writer; its policy must not swallow
  -- revision exhaustion or a missing workspace singleton.
  SELECT RAISE(ABORT, 'Revision exhausted or workspace version missing.')
  WHERE NOT EXISTS (SELECT 1 FROM workspace_versions WHERE id=1 AND structural_revision < 9007199254740991)
    OR EXISTS (SELECT 1 FROM entity_versions WHERE entity='task' AND entity_key=NEW.id AND revision >= 9007199254740991);
  INSERT INTO entity_versions(entity,entity_key,revision,deleted_at)
  VALUES('task',NEW.id,1,NULL)
  ON CONFLICT(entity,entity_key) DO UPDATE SET revision=entity_versions.revision+1,deleted_at=excluded.deleted_at;
  UPDATE workspace_versions SET structural_revision=structural_revision+1 WHERE id=1;
END;
CREATE TRIGGER IF NOT EXISTS tasks_version_delete AFTER DELETE ON tasks
BEGIN
  -- RAISE aborts even an outer OR IGNORE writer; its policy must not swallow
  -- revision exhaustion or a missing workspace singleton.
  SELECT RAISE(ABORT, 'Revision exhausted or workspace version missing.')
  WHERE NOT EXISTS (SELECT 1 FROM workspace_versions WHERE id=1 AND structural_revision < 9007199254740991)
    OR EXISTS (SELECT 1 FROM entity_versions WHERE entity='task' AND entity_key=OLD.id AND revision >= 9007199254740991);
  INSERT INTO entity_versions(entity,entity_key,revision,deleted_at)
  VALUES('task',OLD.id,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  ON CONFLICT(entity,entity_key) DO UPDATE SET revision=entity_versions.revision+1,deleted_at=excluded.deleted_at;
  UPDATE workspace_versions SET structural_revision=structural_revision+1 WHERE id=1;
END;

INSERT OR IGNORE INTO entity_versions(entity,entity_key,revision,deleted_at) SELECT 'project',id,0,NULL FROM projects;
CREATE TRIGGER IF NOT EXISTS projects_immutable_identity BEFORE UPDATE ON projects
WHEN OLD.id IS NOT NEW.id
BEGIN
  SELECT RAISE(ABORT, 'Entity identity is immutable; delete/create explicitly.');
END;
CREATE TRIGGER IF NOT EXISTS projects_version_insert AFTER INSERT ON projects
BEGIN
  -- RAISE aborts even an outer OR IGNORE writer; its policy must not swallow
  -- revision exhaustion or a missing workspace singleton.
  SELECT RAISE(ABORT, 'Revision exhausted or workspace version missing.')
  WHERE NOT EXISTS (SELECT 1 FROM workspace_versions WHERE id=1 AND structural_revision < 9007199254740991)
    OR EXISTS (SELECT 1 FROM entity_versions WHERE entity='project' AND entity_key=NEW.id AND revision >= 9007199254740991);
  INSERT INTO entity_versions(entity,entity_key,revision,deleted_at)
  VALUES('project',NEW.id,1,NULL)
  ON CONFLICT(entity,entity_key) DO UPDATE SET revision=entity_versions.revision+1,deleted_at=excluded.deleted_at;
  UPDATE workspace_versions SET structural_revision=structural_revision+1 WHERE id=1;
END;
CREATE TRIGGER IF NOT EXISTS projects_version_update AFTER UPDATE ON projects
BEGIN
  -- RAISE aborts even an outer OR IGNORE writer; its policy must not swallow
  -- revision exhaustion or a missing workspace singleton.
  SELECT RAISE(ABORT, 'Revision exhausted or workspace version missing.')
  WHERE NOT EXISTS (SELECT 1 FROM workspace_versions WHERE id=1 AND structural_revision < 9007199254740991)
    OR EXISTS (SELECT 1 FROM entity_versions WHERE entity='project' AND entity_key=NEW.id AND revision >= 9007199254740991);
  INSERT INTO entity_versions(entity,entity_key,revision,deleted_at)
  VALUES('project',NEW.id,1,NULL)
  ON CONFLICT(entity,entity_key) DO UPDATE SET revision=entity_versions.revision+1,deleted_at=excluded.deleted_at;
  UPDATE workspace_versions SET structural_revision=structural_revision+1 WHERE id=1;
END;
CREATE TRIGGER IF NOT EXISTS projects_version_delete AFTER DELETE ON projects
BEGIN
  -- RAISE aborts even an outer OR IGNORE writer; its policy must not swallow
  -- revision exhaustion or a missing workspace singleton.
  SELECT RAISE(ABORT, 'Revision exhausted or workspace version missing.')
  WHERE NOT EXISTS (SELECT 1 FROM workspace_versions WHERE id=1 AND structural_revision < 9007199254740991)
    OR EXISTS (SELECT 1 FROM entity_versions WHERE entity='project' AND entity_key=OLD.id AND revision >= 9007199254740991);
  INSERT INTO entity_versions(entity,entity_key,revision,deleted_at)
  VALUES('project',OLD.id,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  ON CONFLICT(entity,entity_key) DO UPDATE SET revision=entity_versions.revision+1,deleted_at=excluded.deleted_at;
  UPDATE workspace_versions SET structural_revision=structural_revision+1 WHERE id=1;
END;

INSERT OR IGNORE INTO entity_versions(entity,entity_key,revision,deleted_at) SELECT 'link',json_array(from_task_id,to_task_id,link_type),0,NULL FROM task_links;
CREATE TRIGGER IF NOT EXISTS task_links_immutable_identity BEFORE UPDATE ON task_links
WHEN OLD.from_task_id IS NOT NEW.from_task_id OR OLD.to_task_id IS NOT NEW.to_task_id OR OLD.link_type IS NOT NEW.link_type
BEGIN
  SELECT RAISE(ABORT, 'Entity identity is immutable; delete/create explicitly.');
END;
CREATE TRIGGER IF NOT EXISTS task_links_version_insert AFTER INSERT ON task_links
BEGIN
  -- RAISE aborts even an outer OR IGNORE writer; its policy must not swallow
  -- revision exhaustion or a missing workspace singleton.
  SELECT RAISE(ABORT, 'Revision exhausted or workspace version missing.')
  WHERE NOT EXISTS (SELECT 1 FROM workspace_versions WHERE id=1 AND structural_revision < 9007199254740991)
    OR EXISTS (SELECT 1 FROM entity_versions WHERE entity='link' AND entity_key=json_array(NEW.from_task_id,NEW.to_task_id,NEW.link_type) AND revision >= 9007199254740991);
  INSERT INTO entity_versions(entity,entity_key,revision,deleted_at)
  VALUES('link',json_array(NEW.from_task_id,NEW.to_task_id,NEW.link_type),1,NULL)
  ON CONFLICT(entity,entity_key) DO UPDATE SET revision=entity_versions.revision+1,deleted_at=excluded.deleted_at;
  UPDATE workspace_versions SET structural_revision=structural_revision+1 WHERE id=1;
END;
CREATE TRIGGER IF NOT EXISTS task_links_version_update AFTER UPDATE ON task_links
BEGIN
  -- RAISE aborts even an outer OR IGNORE writer; its policy must not swallow
  -- revision exhaustion or a missing workspace singleton.
  SELECT RAISE(ABORT, 'Revision exhausted or workspace version missing.')
  WHERE NOT EXISTS (SELECT 1 FROM workspace_versions WHERE id=1 AND structural_revision < 9007199254740991)
    OR EXISTS (SELECT 1 FROM entity_versions WHERE entity='link' AND entity_key=json_array(NEW.from_task_id,NEW.to_task_id,NEW.link_type) AND revision >= 9007199254740991);
  INSERT INTO entity_versions(entity,entity_key,revision,deleted_at)
  VALUES('link',json_array(NEW.from_task_id,NEW.to_task_id,NEW.link_type),1,NULL)
  ON CONFLICT(entity,entity_key) DO UPDATE SET revision=entity_versions.revision+1,deleted_at=excluded.deleted_at;
  UPDATE workspace_versions SET structural_revision=structural_revision+1 WHERE id=1;
END;
CREATE TRIGGER IF NOT EXISTS task_links_version_delete AFTER DELETE ON task_links
BEGIN
  -- RAISE aborts even an outer OR IGNORE writer; its policy must not swallow
  -- revision exhaustion or a missing workspace singleton.
  SELECT RAISE(ABORT, 'Revision exhausted or workspace version missing.')
  WHERE NOT EXISTS (SELECT 1 FROM workspace_versions WHERE id=1 AND structural_revision < 9007199254740991)
    OR EXISTS (SELECT 1 FROM entity_versions WHERE entity='link' AND entity_key=json_array(OLD.from_task_id,OLD.to_task_id,OLD.link_type) AND revision >= 9007199254740991);
  INSERT INTO entity_versions(entity,entity_key,revision,deleted_at)
  VALUES('link',json_array(OLD.from_task_id,OLD.to_task_id,OLD.link_type),1,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  ON CONFLICT(entity,entity_key) DO UPDATE SET revision=entity_versions.revision+1,deleted_at=excluded.deleted_at;
  UPDATE workspace_versions SET structural_revision=structural_revision+1 WHERE id=1;
END;

INSERT OR IGNORE INTO entity_versions(entity,entity_key,revision,deleted_at) SELECT 'duty',id,0,NULL FROM duties;
CREATE TRIGGER IF NOT EXISTS duties_immutable_identity BEFORE UPDATE ON duties
WHEN OLD.id IS NOT NEW.id
BEGIN
  SELECT RAISE(ABORT, 'Entity identity is immutable; delete/create explicitly.');
END;
CREATE TRIGGER IF NOT EXISTS duties_version_insert AFTER INSERT ON duties
BEGIN
  -- RAISE aborts even an outer OR IGNORE writer; its policy must not swallow
  -- revision exhaustion or a missing workspace singleton.
  SELECT RAISE(ABORT, 'Revision exhausted or workspace version missing.')
  WHERE NOT EXISTS (SELECT 1 FROM workspace_versions WHERE id=1 AND structural_revision < 9007199254740991)
    OR EXISTS (SELECT 1 FROM entity_versions WHERE entity='duty' AND entity_key=NEW.id AND revision >= 9007199254740991);
  INSERT INTO entity_versions(entity,entity_key,revision,deleted_at)
  VALUES('duty',NEW.id,1,NULL)
  ON CONFLICT(entity,entity_key) DO UPDATE SET revision=entity_versions.revision+1,deleted_at=excluded.deleted_at;
  UPDATE workspace_versions SET structural_revision=structural_revision+1 WHERE id=1;
END;
CREATE TRIGGER IF NOT EXISTS duties_version_update AFTER UPDATE ON duties
BEGIN
  -- RAISE aborts even an outer OR IGNORE writer; its policy must not swallow
  -- revision exhaustion or a missing workspace singleton.
  SELECT RAISE(ABORT, 'Revision exhausted or workspace version missing.')
  WHERE NOT EXISTS (SELECT 1 FROM workspace_versions WHERE id=1 AND structural_revision < 9007199254740991)
    OR EXISTS (SELECT 1 FROM entity_versions WHERE entity='duty' AND entity_key=NEW.id AND revision >= 9007199254740991);
  INSERT INTO entity_versions(entity,entity_key,revision,deleted_at)
  VALUES('duty',NEW.id,1,NULL)
  ON CONFLICT(entity,entity_key) DO UPDATE SET revision=entity_versions.revision+1,deleted_at=excluded.deleted_at;
  UPDATE workspace_versions SET structural_revision=structural_revision+1 WHERE id=1;
END;
CREATE TRIGGER IF NOT EXISTS duties_version_delete AFTER DELETE ON duties
BEGIN
  -- RAISE aborts even an outer OR IGNORE writer; its policy must not swallow
  -- revision exhaustion or a missing workspace singleton.
  SELECT RAISE(ABORT, 'Revision exhausted or workspace version missing.')
  WHERE NOT EXISTS (SELECT 1 FROM workspace_versions WHERE id=1 AND structural_revision < 9007199254740991)
    OR EXISTS (SELECT 1 FROM entity_versions WHERE entity='duty' AND entity_key=OLD.id AND revision >= 9007199254740991);
  INSERT INTO entity_versions(entity,entity_key,revision,deleted_at)
  VALUES('duty',OLD.id,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  ON CONFLICT(entity,entity_key) DO UPDATE SET revision=entity_versions.revision+1,deleted_at=excluded.deleted_at;
  UPDATE workspace_versions SET structural_revision=structural_revision+1 WHERE id=1;
END;
