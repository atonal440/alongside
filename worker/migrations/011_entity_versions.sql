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
