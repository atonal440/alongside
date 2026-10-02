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
    OR (NEW.deleted_at IS NULL AND (SELECT json_object('id',id,'title',title,'notes',notes,'status',status,'due_date',due_date,'due_all_day',CASE due_all_day WHEN 1 THEN json('true') WHEN 0 THEN json('false') ELSE due_all_day END,'recurrence',recurrence,'created_at',created_at,'updated_at',updated_at,'defer_until',defer_until,'defer_kind',defer_kind,'task_type',task_type,'project_id',project_id,'kickoff_note',kickoff_note,'session_log',session_log,'focused_until',focused_until,'duty_id',duty_id,'occurrence_at',occurrence_at) FROM tasks WHERE id=NEW.entity_key) IS NULL);
  INSERT INTO sync_feed(epoch,entity,entity_key,revision,operation,row_json,deleted_at,recorded_at)
  VALUES((SELECT epoch FROM sync_metadata WHERE id=1),NEW.entity,NEW.entity_key,NEW.revision,
    CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'delete' END,
    CASE WHEN NEW.deleted_at IS NULL THEN (SELECT json_object('id',id,'title',title,'notes',notes,'status',status,'due_date',due_date,'due_all_day',CASE due_all_day WHEN 1 THEN json('true') WHEN 0 THEN json('false') ELSE due_all_day END,'recurrence',recurrence,'created_at',created_at,'updated_at',updated_at,'defer_until',defer_until,'defer_kind',defer_kind,'task_type',task_type,'project_id',project_id,'kickoff_note',kickoff_note,'session_log',session_log,'focused_until',focused_until,'duty_id',duty_id,'occurrence_at',occurrence_at) FROM tasks WHERE id=NEW.entity_key) ELSE 'null' END,
    NEW.deleted_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

-- Observe the ledger, not sibling row triggers whose execution order varies.
CREATE TRIGGER IF NOT EXISTS sync_task_update AFTER UPDATE ON entity_versions
WHEN NEW.entity='task'
BEGIN
  SELECT RAISE(ABORT,'Sync metadata missing or live source row missing.')
  WHERE NOT EXISTS(SELECT 1 FROM sync_metadata WHERE id=1)
    OR (NEW.deleted_at IS NULL AND (SELECT json_object('id',id,'title',title,'notes',notes,'status',status,'due_date',due_date,'due_all_day',CASE due_all_day WHEN 1 THEN json('true') WHEN 0 THEN json('false') ELSE due_all_day END,'recurrence',recurrence,'created_at',created_at,'updated_at',updated_at,'defer_until',defer_until,'defer_kind',defer_kind,'task_type',task_type,'project_id',project_id,'kickoff_note',kickoff_note,'session_log',session_log,'focused_until',focused_until,'duty_id',duty_id,'occurrence_at',occurrence_at) FROM tasks WHERE id=NEW.entity_key) IS NULL);
  INSERT INTO sync_feed(epoch,entity,entity_key,revision,operation,row_json,deleted_at,recorded_at)
  VALUES((SELECT epoch FROM sync_metadata WHERE id=1),NEW.entity,NEW.entity_key,NEW.revision,
    CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'delete' END,
    CASE WHEN NEW.deleted_at IS NULL THEN (SELECT json_object('id',id,'title',title,'notes',notes,'status',status,'due_date',due_date,'due_all_day',CASE due_all_day WHEN 1 THEN json('true') WHEN 0 THEN json('false') ELSE due_all_day END,'recurrence',recurrence,'created_at',created_at,'updated_at',updated_at,'defer_until',defer_until,'defer_kind',defer_kind,'task_type',task_type,'project_id',project_id,'kickoff_note',kickoff_note,'session_log',session_log,'focused_until',focused_until,'duty_id',duty_id,'occurrence_at',occurrence_at) FROM tasks WHERE id=NEW.entity_key) ELSE 'null' END,
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
