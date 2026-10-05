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
  occurrence_at TEXT,               -- UTC datetime; the duty occurrence this task instance is
  available_from TEXT CHECK (available_from IS NULL OR (json_valid(available_from) AND json_type(available_from) = 'object')),  -- TemporalPoint JSON: earliest permitted start
  deadline      TEXT CHECK (deadline IS NULL OR (json_valid(deadline) AND json_type(deadline) = 'object')),  -- TemporalPoint JSON: hard completion boundary
  parent_id     TEXT,               -- parent task id (no FK: planners own integrity); null = top level
  position      REAL CHECK (position IS NULL OR (typeof(position) IN ('integer','real') AND position = position))  -- sibling sort key, ascending
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
  operation TEXT NOT NULL CHECK (operation IN ('upsert','delete')),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  created_at TEXT NOT NULL,
  CHECK ((entity = 'planning_settings' AND entity_id = 'workspace') OR (entity = 'task' AND entity_id GLOB 't_*') OR (entity = 'project' AND entity_id GLOB 'p_*') OR (entity = 'duty' AND entity_id GLOB 'd_*') OR (entity = 'link' AND CASE WHEN json_valid(entity_id) THEN json_type(entity_id) = 'array' AND json_array_length(entity_id) = 3 AND json_type(entity_id,'$[0]') = 'text' AND json_extract(entity_id,'$[0]') GLOB 't_*' AND json_type(entity_id,'$[1]') = 'text' AND json_extract(entity_id,'$[1]') GLOB 't_*' AND json_type(entity_id,'$[2]') = 'text' AND json_extract(entity_id,'$[2]') IN ('blocks','related') ELSE 0 END))
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

-- Workspace delta foundation: every user-data writer participates atomically.
-- Existing rows bootstrap at revision zero; no retroactive feed entries.
-- Public snapshot/delta reads and restore epochs are separate rollout steps.
CREATE TABLE IF NOT EXISTS sync_metadata (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  epoch INTEGER NOT NULL DEFAULT 0 CHECK (typeof(epoch) = 'integer' AND epoch BETWEEN 0 AND 9007199254740991),
  watermark INTEGER NOT NULL DEFAULT 0 CHECK (typeof(watermark) = 'integer' AND watermark BETWEEN 0 AND 9007199254740991),
  retention_floor INTEGER NOT NULL DEFAULT 0 CHECK (typeof(retention_floor) = 'integer' AND retention_floor BETWEEN 0 AND watermark)
);
INSERT INTO sync_metadata(id) SELECT 1 WHERE NOT EXISTS(SELECT 1 FROM sync_metadata);
CREATE TABLE IF NOT EXISTS sync_aux_versions (
  entity TEXT NOT NULL CHECK (entity IN ('preference','planning_settings','action_log','command_audit')),
  entity_key TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision BETWEEN 0 AND 9007199254740991),
  deleted_at TEXT,
  PRIMARY KEY(entity,entity_key)
);
CREATE TABLE IF NOT EXISTS sync_feed (
  seq INTEGER PRIMARY KEY AUTOINCREMENT CHECK (typeof(seq) = 'integer' AND seq BETWEEN 1 AND 9007199254740991),
  epoch INTEGER NOT NULL CHECK (typeof(epoch) = 'integer' AND epoch BETWEEN 0 AND 9007199254740991),
  entity TEXT NOT NULL CHECK (entity IN ('task','project','link','duty','preference','planning_settings','action_log','command_audit')),
  entity_key TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (typeof(revision) = 'integer' AND revision BETWEEN 0 AND 9007199254740991),
  operation TEXT NOT NULL CHECK (operation IN ('upsert','delete')),
  row_json TEXT NOT NULL CHECK (json_valid(row_json)),
  deleted_at TEXT,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS sync_feed_entity ON sync_feed(entity,entity_key,seq);

-- Never silently omit a feed event, even under outer INSERT OR IGNORE.
CREATE TRIGGER IF NOT EXISTS sync_feed_capacity BEFORE INSERT ON sync_feed
BEGIN
  SELECT RAISE(ABORT,'Sync sequence exhausted or metadata missing.')
  WHERE NOT EXISTS(SELECT 1 FROM sync_metadata WHERE id=1 AND watermark < 9007199254740991 AND epoch=NEW.epoch)
    OR EXISTS(SELECT 1 FROM sqlite_sequence WHERE name='sync_feed' AND seq >= 9007199254740991)
    OR (NEW.seq != -1 AND (typeof(NEW.seq) != 'integer' OR NEW.seq <= (SELECT watermark FROM sync_metadata WHERE id=1) OR NEW.seq > 9007199254740991))
    OR NEW.revision < 0 OR NEW.revision > 9007199254740991 OR typeof(NEW.revision) != 'integer'
    OR NOT json_valid(NEW.row_json)
    OR (NEW.operation='upsert' AND (NEW.deleted_at IS NOT NULL OR json_type(NEW.row_json) != 'object'))
    OR (NEW.operation='delete' AND (NEW.deleted_at IS NULL OR NEW.row_json != 'null'));
END;
CREATE TRIGGER IF NOT EXISTS sync_feed_watermark AFTER INSERT ON sync_feed
BEGIN
  UPDATE sync_metadata SET watermark=MAX(watermark,NEW.seq) WHERE id=1;
END;
-- Purging any history conservatively expires all cursors below that sequence.
-- No automatic purge is installed; receipts and revision ledgers are retained.
CREATE TRIGGER IF NOT EXISTS sync_feed_retention AFTER DELETE ON sync_feed
BEGIN
  UPDATE sync_metadata SET retention_floor=MAX(retention_floor,OLD.seq) WHERE id=1;
END;
CREATE TRIGGER IF NOT EXISTS sync_feed_immutable BEFORE UPDATE ON sync_feed
BEGIN SELECT RAISE(ABORT,'Sync history is immutable.'); END;
CREATE TRIGGER IF NOT EXISTS sync_metadata_singleton BEFORE INSERT ON sync_metadata
WHEN EXISTS(SELECT 1 FROM sync_metadata)
BEGIN SELECT RAISE(ABORT,'Sync metadata cannot be replaced.'); END;
CREATE TRIGGER IF NOT EXISTS sync_metadata_monotonic BEFORE UPDATE ON sync_metadata
WHEN NEW.id IS NOT OLD.id OR NEW.epoch < OLD.epoch OR NEW.watermark < OLD.watermark OR NEW.retention_floor < OLD.retention_floor
BEGIN SELECT RAISE(ABORT,'Sync metadata must be monotonic.'); END;
CREATE TRIGGER IF NOT EXISTS sync_metadata_retained BEFORE DELETE ON sync_metadata
BEGIN SELECT RAISE(ABORT,'Sync metadata must be retained.'); END;
CREATE TRIGGER IF NOT EXISTS sync_aux_identity BEFORE UPDATE ON sync_aux_versions
WHEN NEW.entity IS NOT OLD.entity OR NEW.entity_key IS NOT OLD.entity_key OR NEW.revision <= OLD.revision
BEGIN SELECT RAISE(ABORT,'Sync identity is immutable and revision must advance.'); END;
CREATE TRIGGER IF NOT EXISTS sync_aux_retained BEFORE DELETE ON sync_aux_versions
BEGIN SELECT RAISE(ABORT,'Sync revisions must be retained.'); END;

INSERT OR IGNORE INTO sync_aux_versions SELECT 'preference',key,0,NULL FROM user_preferences;
INSERT OR IGNORE INTO sync_aux_versions SELECT 'planning_settings','workspace',0,NULL FROM planning_settings;
INSERT OR IGNORE INTO sync_aux_versions SELECT 'action_log',CAST(id AS TEXT),0,NULL FROM action_log;
INSERT OR IGNORE INTO sync_aux_versions SELECT 'command_audit',command_id,0,NULL FROM command_audit;

-- Observe the ledger, not sibling row triggers whose execution order varies.
CREATE TRIGGER IF NOT EXISTS sync_task_insert AFTER INSERT ON entity_versions
WHEN NEW.entity='task'
BEGIN
  SELECT RAISE(ABORT,'Sync metadata missing or live source row missing.')
  WHERE NOT EXISTS(SELECT 1 FROM sync_metadata WHERE id=1)
    OR (NEW.deleted_at IS NULL AND (SELECT json_object('id',id,'title',title,'notes',notes,'status',status,'due_date',due_date,'due_all_day',CASE due_all_day WHEN 1 THEN json('true') WHEN 0 THEN json('false') ELSE due_all_day END,'recurrence',recurrence,'created_at',created_at,'updated_at',updated_at,'defer_until',defer_until,'defer_kind',defer_kind,'task_type',task_type,'project_id',project_id,'kickoff_note',kickoff_note,'session_log',session_log,'focused_until',focused_until,'duty_id',duty_id,'occurrence_at',occurrence_at,'available_from',available_from,'deadline',deadline,'parent_id',parent_id,'position',position) FROM tasks WHERE id=NEW.entity_key) IS NULL);
  INSERT INTO sync_feed(epoch,entity,entity_key,revision,operation,row_json,deleted_at,recorded_at)
  VALUES((SELECT epoch FROM sync_metadata WHERE id=1),NEW.entity,NEW.entity_key,NEW.revision,
    CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'delete' END,
    CASE WHEN NEW.deleted_at IS NULL THEN (SELECT json_object('id',id,'title',title,'notes',notes,'status',status,'due_date',due_date,'due_all_day',CASE due_all_day WHEN 1 THEN json('true') WHEN 0 THEN json('false') ELSE due_all_day END,'recurrence',recurrence,'created_at',created_at,'updated_at',updated_at,'defer_until',defer_until,'defer_kind',defer_kind,'task_type',task_type,'project_id',project_id,'kickoff_note',kickoff_note,'session_log',session_log,'focused_until',focused_until,'duty_id',duty_id,'occurrence_at',occurrence_at,'available_from',available_from,'deadline',deadline,'parent_id',parent_id,'position',position) FROM tasks WHERE id=NEW.entity_key) ELSE 'null' END,
    NEW.deleted_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

-- Observe the ledger, not sibling row triggers whose execution order varies.
CREATE TRIGGER IF NOT EXISTS sync_task_update AFTER UPDATE ON entity_versions
WHEN NEW.entity='task'
BEGIN
  SELECT RAISE(ABORT,'Sync metadata missing or live source row missing.')
  WHERE NOT EXISTS(SELECT 1 FROM sync_metadata WHERE id=1)
    OR (NEW.deleted_at IS NULL AND (SELECT json_object('id',id,'title',title,'notes',notes,'status',status,'due_date',due_date,'due_all_day',CASE due_all_day WHEN 1 THEN json('true') WHEN 0 THEN json('false') ELSE due_all_day END,'recurrence',recurrence,'created_at',created_at,'updated_at',updated_at,'defer_until',defer_until,'defer_kind',defer_kind,'task_type',task_type,'project_id',project_id,'kickoff_note',kickoff_note,'session_log',session_log,'focused_until',focused_until,'duty_id',duty_id,'occurrence_at',occurrence_at,'available_from',available_from,'deadline',deadline,'parent_id',parent_id,'position',position) FROM tasks WHERE id=NEW.entity_key) IS NULL);
  INSERT INTO sync_feed(epoch,entity,entity_key,revision,operation,row_json,deleted_at,recorded_at)
  VALUES((SELECT epoch FROM sync_metadata WHERE id=1),NEW.entity,NEW.entity_key,NEW.revision,
    CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'delete' END,
    CASE WHEN NEW.deleted_at IS NULL THEN (SELECT json_object('id',id,'title',title,'notes',notes,'status',status,'due_date',due_date,'due_all_day',CASE due_all_day WHEN 1 THEN json('true') WHEN 0 THEN json('false') ELSE due_all_day END,'recurrence',recurrence,'created_at',created_at,'updated_at',updated_at,'defer_until',defer_until,'defer_kind',defer_kind,'task_type',task_type,'project_id',project_id,'kickoff_note',kickoff_note,'session_log',session_log,'focused_until',focused_until,'duty_id',duty_id,'occurrence_at',occurrence_at,'available_from',available_from,'deadline',deadline,'parent_id',parent_id,'position',position) FROM tasks WHERE id=NEW.entity_key) ELSE 'null' END,
    NEW.deleted_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

-- Observe the ledger, not sibling row triggers whose execution order varies.
CREATE TRIGGER IF NOT EXISTS sync_project_insert AFTER INSERT ON entity_versions
WHEN NEW.entity='project'
BEGIN
  SELECT RAISE(ABORT,'Sync metadata missing or live source row missing.')
  WHERE NOT EXISTS(SELECT 1 FROM sync_metadata WHERE id=1)
    OR (NEW.deleted_at IS NULL AND (SELECT json_object('id',id,'title',title,'notes',notes,'kickoff_note',kickoff_note,'status',status,'created_at',created_at,'updated_at',updated_at) FROM projects WHERE id=NEW.entity_key) IS NULL);
  INSERT INTO sync_feed(epoch,entity,entity_key,revision,operation,row_json,deleted_at,recorded_at)
  VALUES((SELECT epoch FROM sync_metadata WHERE id=1),NEW.entity,NEW.entity_key,NEW.revision,
    CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'delete' END,
    CASE WHEN NEW.deleted_at IS NULL THEN (SELECT json_object('id',id,'title',title,'notes',notes,'kickoff_note',kickoff_note,'status',status,'created_at',created_at,'updated_at',updated_at) FROM projects WHERE id=NEW.entity_key) ELSE 'null' END,
    NEW.deleted_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

-- Observe the ledger, not sibling row triggers whose execution order varies.
CREATE TRIGGER IF NOT EXISTS sync_project_update AFTER UPDATE ON entity_versions
WHEN NEW.entity='project'
BEGIN
  SELECT RAISE(ABORT,'Sync metadata missing or live source row missing.')
  WHERE NOT EXISTS(SELECT 1 FROM sync_metadata WHERE id=1)
    OR (NEW.deleted_at IS NULL AND (SELECT json_object('id',id,'title',title,'notes',notes,'kickoff_note',kickoff_note,'status',status,'created_at',created_at,'updated_at',updated_at) FROM projects WHERE id=NEW.entity_key) IS NULL);
  INSERT INTO sync_feed(epoch,entity,entity_key,revision,operation,row_json,deleted_at,recorded_at)
  VALUES((SELECT epoch FROM sync_metadata WHERE id=1),NEW.entity,NEW.entity_key,NEW.revision,
    CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'delete' END,
    CASE WHEN NEW.deleted_at IS NULL THEN (SELECT json_object('id',id,'title',title,'notes',notes,'kickoff_note',kickoff_note,'status',status,'created_at',created_at,'updated_at',updated_at) FROM projects WHERE id=NEW.entity_key) ELSE 'null' END,
    NEW.deleted_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

-- Observe the ledger, not sibling row triggers whose execution order varies.
CREATE TRIGGER IF NOT EXISTS sync_link_insert AFTER INSERT ON entity_versions
WHEN NEW.entity='link'
BEGIN
  SELECT RAISE(ABORT,'Sync metadata missing or live source row missing.')
  WHERE NOT EXISTS(SELECT 1 FROM sync_metadata WHERE id=1)
    OR (NEW.deleted_at IS NULL AND (SELECT json_object('from_task_id',from_task_id,'to_task_id',to_task_id,'link_type',link_type) FROM task_links WHERE json_array(from_task_id,to_task_id,link_type)=NEW.entity_key) IS NULL);
  INSERT INTO sync_feed(epoch,entity,entity_key,revision,operation,row_json,deleted_at,recorded_at)
  VALUES((SELECT epoch FROM sync_metadata WHERE id=1),NEW.entity,NEW.entity_key,NEW.revision,
    CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'delete' END,
    CASE WHEN NEW.deleted_at IS NULL THEN (SELECT json_object('from_task_id',from_task_id,'to_task_id',to_task_id,'link_type',link_type) FROM task_links WHERE json_array(from_task_id,to_task_id,link_type)=NEW.entity_key) ELSE 'null' END,
    NEW.deleted_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

-- Observe the ledger, not sibling row triggers whose execution order varies.
CREATE TRIGGER IF NOT EXISTS sync_link_update AFTER UPDATE ON entity_versions
WHEN NEW.entity='link'
BEGIN
  SELECT RAISE(ABORT,'Sync metadata missing or live source row missing.')
  WHERE NOT EXISTS(SELECT 1 FROM sync_metadata WHERE id=1)
    OR (NEW.deleted_at IS NULL AND (SELECT json_object('from_task_id',from_task_id,'to_task_id',to_task_id,'link_type',link_type) FROM task_links WHERE json_array(from_task_id,to_task_id,link_type)=NEW.entity_key) IS NULL);
  INSERT INTO sync_feed(epoch,entity,entity_key,revision,operation,row_json,deleted_at,recorded_at)
  VALUES((SELECT epoch FROM sync_metadata WHERE id=1),NEW.entity,NEW.entity_key,NEW.revision,
    CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'delete' END,
    CASE WHEN NEW.deleted_at IS NULL THEN (SELECT json_object('from_task_id',from_task_id,'to_task_id',to_task_id,'link_type',link_type) FROM task_links WHERE json_array(from_task_id,to_task_id,link_type)=NEW.entity_key) ELSE 'null' END,
    NEW.deleted_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

-- Observe the ledger, not sibling row triggers whose execution order varies.
CREATE TRIGGER IF NOT EXISTS sync_duty_insert AFTER INSERT ON entity_versions
WHEN NEW.entity='duty'
BEGIN
  SELECT RAISE(ABORT,'Sync metadata missing or live source row missing.')
  WHERE NOT EXISTS(SELECT 1 FROM sync_metadata WHERE id=1)
    OR (NEW.deleted_at IS NULL AND (SELECT json_object('id',id,'title',title,'notes',notes,'kickoff_note',kickoff_note,'task_type',task_type,'project_id',project_id,'rrule',rrule,'dtstart',dtstart,'timezone',timezone,'status',status,'catch_up',catch_up,'last_spawned_at',last_spawned_at,'next_occurrence_at',next_occurrence_at,'created_at',created_at,'updated_at',updated_at) FROM duties WHERE id=NEW.entity_key) IS NULL);
  INSERT INTO sync_feed(epoch,entity,entity_key,revision,operation,row_json,deleted_at,recorded_at)
  VALUES((SELECT epoch FROM sync_metadata WHERE id=1),NEW.entity,NEW.entity_key,NEW.revision,
    CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'delete' END,
    CASE WHEN NEW.deleted_at IS NULL THEN (SELECT json_object('id',id,'title',title,'notes',notes,'kickoff_note',kickoff_note,'task_type',task_type,'project_id',project_id,'rrule',rrule,'dtstart',dtstart,'timezone',timezone,'status',status,'catch_up',catch_up,'last_spawned_at',last_spawned_at,'next_occurrence_at',next_occurrence_at,'created_at',created_at,'updated_at',updated_at) FROM duties WHERE id=NEW.entity_key) ELSE 'null' END,
    NEW.deleted_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

-- Observe the ledger, not sibling row triggers whose execution order varies.
CREATE TRIGGER IF NOT EXISTS sync_duty_update AFTER UPDATE ON entity_versions
WHEN NEW.entity='duty'
BEGIN
  SELECT RAISE(ABORT,'Sync metadata missing or live source row missing.')
  WHERE NOT EXISTS(SELECT 1 FROM sync_metadata WHERE id=1)
    OR (NEW.deleted_at IS NULL AND (SELECT json_object('id',id,'title',title,'notes',notes,'kickoff_note',kickoff_note,'task_type',task_type,'project_id',project_id,'rrule',rrule,'dtstart',dtstart,'timezone',timezone,'status',status,'catch_up',catch_up,'last_spawned_at',last_spawned_at,'next_occurrence_at',next_occurrence_at,'created_at',created_at,'updated_at',updated_at) FROM duties WHERE id=NEW.entity_key) IS NULL);
  INSERT INTO sync_feed(epoch,entity,entity_key,revision,operation,row_json,deleted_at,recorded_at)
  VALUES((SELECT epoch FROM sync_metadata WHERE id=1),NEW.entity,NEW.entity_key,NEW.revision,
    CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'delete' END,
    CASE WHEN NEW.deleted_at IS NULL THEN (SELECT json_object('id',id,'title',title,'notes',notes,'kickoff_note',kickoff_note,'task_type',task_type,'project_id',project_id,'rrule',rrule,'dtstart',dtstart,'timezone',timezone,'status',status,'catch_up',catch_up,'last_spawned_at',last_spawned_at,'next_occurrence_at',next_occurrence_at,'created_at',created_at,'updated_at',updated_at) FROM duties WHERE id=NEW.entity_key) ELSE 'null' END,
    NEW.deleted_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

-- Observe the ledger, not sibling row triggers whose execution order varies.
CREATE TRIGGER IF NOT EXISTS sync_preference_insert AFTER INSERT ON sync_aux_versions
WHEN NEW.entity='preference'
BEGIN
  SELECT RAISE(ABORT,'Sync metadata missing or live source row missing.')
  WHERE NOT EXISTS(SELECT 1 FROM sync_metadata WHERE id=1)
    OR (NEW.deleted_at IS NULL AND (SELECT json_object('key',key,'value',value) FROM user_preferences WHERE key=NEW.entity_key) IS NULL);
  INSERT INTO sync_feed(epoch,entity,entity_key,revision,operation,row_json,deleted_at,recorded_at)
  VALUES((SELECT epoch FROM sync_metadata WHERE id=1),NEW.entity,NEW.entity_key,NEW.revision,
    CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'delete' END,
    CASE WHEN NEW.deleted_at IS NULL THEN (SELECT json_object('key',key,'value',value) FROM user_preferences WHERE key=NEW.entity_key) ELSE 'null' END,
    NEW.deleted_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

-- Observe the ledger, not sibling row triggers whose execution order varies.
CREATE TRIGGER IF NOT EXISTS sync_preference_update AFTER UPDATE ON sync_aux_versions
WHEN NEW.entity='preference'
BEGIN
  SELECT RAISE(ABORT,'Sync metadata missing or live source row missing.')
  WHERE NOT EXISTS(SELECT 1 FROM sync_metadata WHERE id=1)
    OR (NEW.deleted_at IS NULL AND (SELECT json_object('key',key,'value',value) FROM user_preferences WHERE key=NEW.entity_key) IS NULL);
  INSERT INTO sync_feed(epoch,entity,entity_key,revision,operation,row_json,deleted_at,recorded_at)
  VALUES((SELECT epoch FROM sync_metadata WHERE id=1),NEW.entity,NEW.entity_key,NEW.revision,
    CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'delete' END,
    CASE WHEN NEW.deleted_at IS NULL THEN (SELECT json_object('key',key,'value',value) FROM user_preferences WHERE key=NEW.entity_key) ELSE 'null' END,
    NEW.deleted_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

-- Observe the ledger, not sibling row triggers whose execution order varies.
CREATE TRIGGER IF NOT EXISTS sync_action_log_insert AFTER INSERT ON sync_aux_versions
WHEN NEW.entity='action_log'
BEGIN
  SELECT RAISE(ABORT,'Sync metadata missing or live source row missing.')
  WHERE NOT EXISTS(SELECT 1 FROM sync_metadata WHERE id=1)
    OR (NEW.deleted_at IS NULL AND (SELECT json_object('id',id,'tool_name',tool_name,'task_id',task_id,'duty_id',duty_id,'title',title,'detail',detail,'created_at',created_at) FROM action_log WHERE CAST(id AS TEXT)=NEW.entity_key) IS NULL);
  INSERT INTO sync_feed(epoch,entity,entity_key,revision,operation,row_json,deleted_at,recorded_at)
  VALUES((SELECT epoch FROM sync_metadata WHERE id=1),NEW.entity,NEW.entity_key,NEW.revision,
    CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'delete' END,
    CASE WHEN NEW.deleted_at IS NULL THEN (SELECT json_object('id',id,'tool_name',tool_name,'task_id',task_id,'duty_id',duty_id,'title',title,'detail',detail,'created_at',created_at) FROM action_log WHERE CAST(id AS TEXT)=NEW.entity_key) ELSE 'null' END,
    NEW.deleted_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

-- Observe the ledger, not sibling row triggers whose execution order varies.
CREATE TRIGGER IF NOT EXISTS sync_action_log_update AFTER UPDATE ON sync_aux_versions
WHEN NEW.entity='action_log'
BEGIN
  SELECT RAISE(ABORT,'Sync metadata missing or live source row missing.')
  WHERE NOT EXISTS(SELECT 1 FROM sync_metadata WHERE id=1)
    OR (NEW.deleted_at IS NULL AND (SELECT json_object('id',id,'tool_name',tool_name,'task_id',task_id,'duty_id',duty_id,'title',title,'detail',detail,'created_at',created_at) FROM action_log WHERE CAST(id AS TEXT)=NEW.entity_key) IS NULL);
  INSERT INTO sync_feed(epoch,entity,entity_key,revision,operation,row_json,deleted_at,recorded_at)
  VALUES((SELECT epoch FROM sync_metadata WHERE id=1),NEW.entity,NEW.entity_key,NEW.revision,
    CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'delete' END,
    CASE WHEN NEW.deleted_at IS NULL THEN (SELECT json_object('id',id,'tool_name',tool_name,'task_id',task_id,'duty_id',duty_id,'title',title,'detail',detail,'created_at',created_at) FROM action_log WHERE CAST(id AS TEXT)=NEW.entity_key) ELSE 'null' END,
    NEW.deleted_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

-- Observe the ledger, not sibling row triggers whose execution order varies.
CREATE TRIGGER IF NOT EXISTS sync_command_audit_insert AFTER INSERT ON sync_aux_versions
WHEN NEW.entity='command_audit'
BEGIN
  SELECT RAISE(ABORT,'Sync metadata missing or live source row missing.')
  WHERE NOT EXISTS(SELECT 1 FROM sync_metadata WHERE id=1)
    OR (NEW.deleted_at IS NULL AND (SELECT json_object('command_id',command_id,'actor',actor,'reason',reason,'changes_json',changes_json,'created_at',created_at) FROM command_audit WHERE command_id=NEW.entity_key) IS NULL);
  INSERT INTO sync_feed(epoch,entity,entity_key,revision,operation,row_json,deleted_at,recorded_at)
  VALUES((SELECT epoch FROM sync_metadata WHERE id=1),NEW.entity,NEW.entity_key,NEW.revision,
    CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'delete' END,
    CASE WHEN NEW.deleted_at IS NULL THEN (SELECT json_object('command_id',command_id,'actor',actor,'reason',reason,'changes_json',changes_json,'created_at',created_at) FROM command_audit WHERE command_id=NEW.entity_key) ELSE 'null' END,
    NEW.deleted_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

-- Observe the ledger, not sibling row triggers whose execution order varies.
CREATE TRIGGER IF NOT EXISTS sync_command_audit_update AFTER UPDATE ON sync_aux_versions
WHEN NEW.entity='command_audit'
BEGIN
  SELECT RAISE(ABORT,'Sync metadata missing or live source row missing.')
  WHERE NOT EXISTS(SELECT 1 FROM sync_metadata WHERE id=1)
    OR (NEW.deleted_at IS NULL AND (SELECT json_object('command_id',command_id,'actor',actor,'reason',reason,'changes_json',changes_json,'created_at',created_at) FROM command_audit WHERE command_id=NEW.entity_key) IS NULL);
  INSERT INTO sync_feed(epoch,entity,entity_key,revision,operation,row_json,deleted_at,recorded_at)
  VALUES((SELECT epoch FROM sync_metadata WHERE id=1),NEW.entity,NEW.entity_key,NEW.revision,
    CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'delete' END,
    CASE WHEN NEW.deleted_at IS NULL THEN (SELECT json_object('command_id',command_id,'actor',actor,'reason',reason,'changes_json',changes_json,'created_at',created_at) FROM command_audit WHERE command_id=NEW.entity_key) ELSE 'null' END,
    NEW.deleted_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

-- Observe the ledger, not sibling row triggers whose execution order varies.
CREATE TRIGGER IF NOT EXISTS sync_planning_settings_insert AFTER INSERT ON sync_aux_versions
WHEN NEW.entity='planning_settings'
BEGIN
  SELECT RAISE(ABORT,'Sync metadata missing or live source row missing.')
  WHERE NOT EXISTS(SELECT 1 FROM sync_metadata WHERE id=1)
    OR (NEW.deleted_at IS NULL AND (SELECT json_object('id',id,'timezone',timezone,'buffer_minutes',buffer_minutes,'revision',revision,'created_at',created_at,'updated_at',updated_at,'working_hours',json((SELECT COALESCE(json_group_array(json_object('weekday',weekday,'start_time',start_time,'end_time',end_time)),'[]') FROM (SELECT weekday,start_time,end_time FROM planning_working_hours WHERE settings_id=1 ORDER BY weekday,start_time)))) FROM planning_settings WHERE 'workspace'=NEW.entity_key) IS NULL);
  INSERT INTO sync_feed(epoch,entity,entity_key,revision,operation,row_json,deleted_at,recorded_at)
  VALUES((SELECT epoch FROM sync_metadata WHERE id=1),NEW.entity,NEW.entity_key,NEW.revision,
    CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'delete' END,
    CASE WHEN NEW.deleted_at IS NULL THEN (SELECT json_object('id',id,'timezone',timezone,'buffer_minutes',buffer_minutes,'revision',revision,'created_at',created_at,'updated_at',updated_at,'working_hours',json((SELECT COALESCE(json_group_array(json_object('weekday',weekday,'start_time',start_time,'end_time',end_time)),'[]') FROM (SELECT weekday,start_time,end_time FROM planning_working_hours WHERE settings_id=1 ORDER BY weekday,start_time)))) FROM planning_settings WHERE 'workspace'=NEW.entity_key) ELSE 'null' END,
    NEW.deleted_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

-- Observe the ledger, not sibling row triggers whose execution order varies.
CREATE TRIGGER IF NOT EXISTS sync_planning_settings_update AFTER UPDATE ON sync_aux_versions
WHEN NEW.entity='planning_settings'
BEGIN
  SELECT RAISE(ABORT,'Sync metadata missing or live source row missing.')
  WHERE NOT EXISTS(SELECT 1 FROM sync_metadata WHERE id=1)
    OR (NEW.deleted_at IS NULL AND (SELECT json_object('id',id,'timezone',timezone,'buffer_minutes',buffer_minutes,'revision',revision,'created_at',created_at,'updated_at',updated_at,'working_hours',json((SELECT COALESCE(json_group_array(json_object('weekday',weekday,'start_time',start_time,'end_time',end_time)),'[]') FROM (SELECT weekday,start_time,end_time FROM planning_working_hours WHERE settings_id=1 ORDER BY weekday,start_time)))) FROM planning_settings WHERE 'workspace'=NEW.entity_key) IS NULL);
  INSERT INTO sync_feed(epoch,entity,entity_key,revision,operation,row_json,deleted_at,recorded_at)
  VALUES((SELECT epoch FROM sync_metadata WHERE id=1),NEW.entity,NEW.entity_key,NEW.revision,
    CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'delete' END,
    CASE WHEN NEW.deleted_at IS NULL THEN (SELECT json_object('id',id,'timezone',timezone,'buffer_minutes',buffer_minutes,'revision',revision,'created_at',created_at,'updated_at',updated_at,'working_hours',json((SELECT COALESCE(json_group_array(json_object('weekday',weekday,'start_time',start_time,'end_time',end_time)),'[]') FROM (SELECT weekday,start_time,end_time FROM planning_working_hours WHERE settings_id=1 ORDER BY weekday,start_time)))) FROM planning_settings WHERE 'workspace'=NEW.entity_key) ELSE 'null' END,
    NEW.deleted_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER IF NOT EXISTS user_preferences_sync_identity BEFORE UPDATE ON user_preferences
WHEN NEW.key IS NOT OLD.key
BEGIN SELECT RAISE(ABORT,'Sync source identity is immutable.'); END;

CREATE TRIGGER IF NOT EXISTS user_preferences_sync_insert AFTER INSERT ON user_preferences
BEGIN
  SELECT RAISE(ABORT,'Sync revision exhausted.')
  WHERE EXISTS(SELECT 1 FROM sync_aux_versions WHERE entity='preference' AND entity_key=NEW.key AND revision >= 9007199254740991);
  INSERT INTO sync_aux_versions(entity,entity_key,revision,deleted_at) VALUES('preference',NEW.key,1,NULL)
  ON CONFLICT(entity,entity_key) DO UPDATE SET revision=sync_aux_versions.revision+1,deleted_at=excluded.deleted_at;
END;

CREATE TRIGGER IF NOT EXISTS user_preferences_sync_update AFTER UPDATE ON user_preferences
BEGIN
  SELECT RAISE(ABORT,'Sync revision exhausted.')
  WHERE EXISTS(SELECT 1 FROM sync_aux_versions WHERE entity='preference' AND entity_key=NEW.key AND revision >= 9007199254740991);
  INSERT INTO sync_aux_versions(entity,entity_key,revision,deleted_at) VALUES('preference',NEW.key,1,NULL)
  ON CONFLICT(entity,entity_key) DO UPDATE SET revision=sync_aux_versions.revision+1,deleted_at=excluded.deleted_at;
END;

CREATE TRIGGER IF NOT EXISTS user_preferences_sync_delete AFTER DELETE ON user_preferences
BEGIN
  SELECT RAISE(ABORT,'Sync revision exhausted.')
  WHERE EXISTS(SELECT 1 FROM sync_aux_versions WHERE entity='preference' AND entity_key=OLD.key AND revision >= 9007199254740991);
  INSERT INTO sync_aux_versions(entity,entity_key,revision,deleted_at) VALUES('preference',OLD.key,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  ON CONFLICT(entity,entity_key) DO UPDATE SET revision=sync_aux_versions.revision+1,deleted_at=excluded.deleted_at;
END;

CREATE TRIGGER IF NOT EXISTS action_log_sync_identity BEFORE UPDATE ON action_log
WHEN NEW.id IS NOT OLD.id
BEGIN SELECT RAISE(ABORT,'Sync source identity is immutable.'); END;

CREATE TRIGGER IF NOT EXISTS action_log_sync_insert AFTER INSERT ON action_log
BEGIN
  SELECT RAISE(ABORT,'Sync revision exhausted.')
  WHERE EXISTS(SELECT 1 FROM sync_aux_versions WHERE entity='action_log' AND entity_key=CAST(NEW.id AS TEXT) AND revision >= 9007199254740991);
  INSERT INTO sync_aux_versions(entity,entity_key,revision,deleted_at) VALUES('action_log',CAST(NEW.id AS TEXT),1,NULL)
  ON CONFLICT(entity,entity_key) DO UPDATE SET revision=sync_aux_versions.revision+1,deleted_at=excluded.deleted_at;
END;

CREATE TRIGGER IF NOT EXISTS action_log_sync_update AFTER UPDATE ON action_log
BEGIN
  SELECT RAISE(ABORT,'Sync revision exhausted.')
  WHERE EXISTS(SELECT 1 FROM sync_aux_versions WHERE entity='action_log' AND entity_key=CAST(NEW.id AS TEXT) AND revision >= 9007199254740991);
  INSERT INTO sync_aux_versions(entity,entity_key,revision,deleted_at) VALUES('action_log',CAST(NEW.id AS TEXT),1,NULL)
  ON CONFLICT(entity,entity_key) DO UPDATE SET revision=sync_aux_versions.revision+1,deleted_at=excluded.deleted_at;
END;

CREATE TRIGGER IF NOT EXISTS action_log_sync_delete AFTER DELETE ON action_log
BEGIN
  SELECT RAISE(ABORT,'Sync revision exhausted.')
  WHERE EXISTS(SELECT 1 FROM sync_aux_versions WHERE entity='action_log' AND entity_key=CAST(OLD.id AS TEXT) AND revision >= 9007199254740991);
  INSERT INTO sync_aux_versions(entity,entity_key,revision,deleted_at) VALUES('action_log',CAST(OLD.id AS TEXT),1,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  ON CONFLICT(entity,entity_key) DO UPDATE SET revision=sync_aux_versions.revision+1,deleted_at=excluded.deleted_at;
END;

CREATE TRIGGER IF NOT EXISTS command_audit_sync_identity BEFORE UPDATE ON command_audit
WHEN NEW.command_id IS NOT OLD.command_id
BEGIN SELECT RAISE(ABORT,'Sync source identity is immutable.'); END;

CREATE TRIGGER IF NOT EXISTS command_audit_sync_insert AFTER INSERT ON command_audit
BEGIN
  SELECT RAISE(ABORT,'Sync revision exhausted.')
  WHERE EXISTS(SELECT 1 FROM sync_aux_versions WHERE entity='command_audit' AND entity_key=NEW.command_id AND revision >= 9007199254740991);
  INSERT INTO sync_aux_versions(entity,entity_key,revision,deleted_at) VALUES('command_audit',NEW.command_id,1,NULL)
  ON CONFLICT(entity,entity_key) DO UPDATE SET revision=sync_aux_versions.revision+1,deleted_at=excluded.deleted_at;
END;

CREATE TRIGGER IF NOT EXISTS command_audit_sync_update AFTER UPDATE ON command_audit
BEGIN
  SELECT RAISE(ABORT,'Sync revision exhausted.')
  WHERE EXISTS(SELECT 1 FROM sync_aux_versions WHERE entity='command_audit' AND entity_key=NEW.command_id AND revision >= 9007199254740991);
  INSERT INTO sync_aux_versions(entity,entity_key,revision,deleted_at) VALUES('command_audit',NEW.command_id,1,NULL)
  ON CONFLICT(entity,entity_key) DO UPDATE SET revision=sync_aux_versions.revision+1,deleted_at=excluded.deleted_at;
END;

CREATE TRIGGER IF NOT EXISTS command_audit_sync_delete AFTER DELETE ON command_audit
BEGIN
  SELECT RAISE(ABORT,'Sync revision exhausted.')
  WHERE EXISTS(SELECT 1 FROM sync_aux_versions WHERE entity='command_audit' AND entity_key=OLD.command_id AND revision >= 9007199254740991);
  INSERT INTO sync_aux_versions(entity,entity_key,revision,deleted_at) VALUES('command_audit',OLD.command_id,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  ON CONFLICT(entity,entity_key) DO UPDATE SET revision=sync_aux_versions.revision+1,deleted_at=excluded.deleted_at;
END;

CREATE TRIGGER IF NOT EXISTS planning_settings_sync_identity BEFORE UPDATE ON planning_settings
WHEN NEW.id IS NOT OLD.id
BEGIN SELECT RAISE(ABORT,'Sync source identity is immutable.'); END;

CREATE TRIGGER IF NOT EXISTS planning_settings_sync_insert AFTER INSERT ON planning_settings
BEGIN
  SELECT RAISE(ABORT,'Sync revision exhausted.')
  WHERE EXISTS(SELECT 1 FROM sync_aux_versions WHERE entity='planning_settings' AND entity_key='workspace' AND revision >= 9007199254740991);
  INSERT INTO sync_aux_versions(entity,entity_key,revision,deleted_at) VALUES('planning_settings','workspace',1,NULL)
  ON CONFLICT(entity,entity_key) DO UPDATE SET revision=sync_aux_versions.revision+1,deleted_at=excluded.deleted_at;
END;

CREATE TRIGGER IF NOT EXISTS planning_settings_sync_update AFTER UPDATE ON planning_settings
BEGIN
  SELECT RAISE(ABORT,'Sync revision exhausted.')
  WHERE EXISTS(SELECT 1 FROM sync_aux_versions WHERE entity='planning_settings' AND entity_key='workspace' AND revision >= 9007199254740991);
  INSERT INTO sync_aux_versions(entity,entity_key,revision,deleted_at) VALUES('planning_settings','workspace',1,NULL)
  ON CONFLICT(entity,entity_key) DO UPDATE SET revision=sync_aux_versions.revision+1,deleted_at=excluded.deleted_at;
END;

CREATE TRIGGER IF NOT EXISTS planning_settings_sync_delete AFTER DELETE ON planning_settings
BEGIN
  SELECT RAISE(ABORT,'Sync revision exhausted.')
  WHERE EXISTS(SELECT 1 FROM sync_aux_versions WHERE entity='planning_settings' AND entity_key='workspace' AND revision >= 9007199254740991);
  INSERT INTO sync_aux_versions(entity,entity_key,revision,deleted_at) VALUES('planning_settings','workspace',1,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  ON CONFLICT(entity,entity_key) DO UPDATE SET revision=sync_aux_versions.revision+1,deleted_at=excluded.deleted_at;
END;

-- Hours belong to the singleton projection, including cascade deletion.
CREATE TRIGGER IF NOT EXISTS planning_hours_sync_insert AFTER INSERT ON planning_working_hours
BEGIN
  SELECT RAISE(ABORT,'Sync revision exhausted.')
  WHERE EXISTS(SELECT 1 FROM sync_aux_versions WHERE entity='planning_settings' AND entity_key='workspace' AND revision >= 9007199254740991);
  INSERT INTO sync_aux_versions(entity,entity_key,revision,deleted_at)
  VALUES('planning_settings','workspace',1,CASE WHEN EXISTS(SELECT 1 FROM planning_settings WHERE id=1) THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ','now') END)
  ON CONFLICT(entity,entity_key) DO UPDATE SET revision=sync_aux_versions.revision+1,deleted_at=excluded.deleted_at;
END;

-- Hours belong to the singleton projection, including cascade deletion.
CREATE TRIGGER IF NOT EXISTS planning_hours_sync_update AFTER UPDATE ON planning_working_hours
BEGIN
  SELECT RAISE(ABORT,'Sync revision exhausted.')
  WHERE EXISTS(SELECT 1 FROM sync_aux_versions WHERE entity='planning_settings' AND entity_key='workspace' AND revision >= 9007199254740991);
  INSERT INTO sync_aux_versions(entity,entity_key,revision,deleted_at)
  VALUES('planning_settings','workspace',1,CASE WHEN EXISTS(SELECT 1 FROM planning_settings WHERE id=1) THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ','now') END)
  ON CONFLICT(entity,entity_key) DO UPDATE SET revision=sync_aux_versions.revision+1,deleted_at=excluded.deleted_at;
END;

-- Hours belong to the singleton projection, including cascade deletion.
CREATE TRIGGER IF NOT EXISTS planning_hours_sync_delete AFTER DELETE ON planning_working_hours
BEGIN
  SELECT RAISE(ABORT,'Sync revision exhausted.')
  WHERE EXISTS(SELECT 1 FROM sync_aux_versions WHERE entity='planning_settings' AND entity_key='workspace' AND revision >= 9007199254740991);
  INSERT INTO sync_aux_versions(entity,entity_key,revision,deleted_at)
  VALUES('planning_settings','workspace',1,CASE WHEN EXISTS(SELECT 1 FROM planning_settings WHERE id=1) THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ','now') END)
  ON CONFLICT(entity,entity_key) DO UPDATE SET revision=sync_aux_versions.revision+1,deleted_at=excluded.deleted_at;
END;
CREATE INDEX IF NOT EXISTS tasks_legacy_recurrence ON tasks(id) WHERE status = 'pending' AND recurrence IS NOT NULL AND duty_id IS NULL;
