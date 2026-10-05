-- v15: Explicit date roles beyond the target date (docs/plans/power-user-todo.md,
-- slice 3). due_date/due_all_day remain the task's *target* ("aim to finish by");
-- these two columns add the other roles:
--   available_from  earliest permitted start, independent of deferral
--   deadline        hard completion boundary
-- Each holds one canonical TemporalPoint JSON object, either
--   {"kind":"date","date":"YYYY-MM-DD","timezone":"<IANA zone>"}  or
--   {"kind":"instant","at":"YYYY-MM-DDTHH:MM:00Z","timezone":"<IANA zone>"}.
-- Null means "not set". Existing rows keep both null; legacy writers cannot
-- touch them. Rows reach the change feed through the task sync triggers below,
-- which are recreated so feed images carry the new columns.

ALTER TABLE tasks ADD COLUMN available_from TEXT CHECK (available_from IS NULL OR (json_valid(available_from) AND json_type(available_from) = 'object'));
ALTER TABLE tasks ADD COLUMN deadline TEXT CHECK (deadline IS NULL OR (json_valid(deadline) AND json_type(deadline) = 'object'));

DROP TRIGGER IF EXISTS sync_task_insert;
CREATE TRIGGER sync_task_insert AFTER INSERT ON entity_versions
WHEN NEW.entity='task'
BEGIN
  SELECT RAISE(ABORT,'Sync metadata missing or live source row missing.')
  WHERE NOT EXISTS(SELECT 1 FROM sync_metadata WHERE id=1)
    OR (NEW.deleted_at IS NULL AND (SELECT json_object('id',id,'title',title,'notes',notes,'status',status,'due_date',due_date,'due_all_day',CASE due_all_day WHEN 1 THEN json('true') WHEN 0 THEN json('false') ELSE due_all_day END,'recurrence',recurrence,'created_at',created_at,'updated_at',updated_at,'defer_until',defer_until,'defer_kind',defer_kind,'task_type',task_type,'project_id',project_id,'kickoff_note',kickoff_note,'session_log',session_log,'focused_until',focused_until,'duty_id',duty_id,'occurrence_at',occurrence_at,'available_from',available_from,'deadline',deadline) FROM tasks WHERE id=NEW.entity_key) IS NULL);
  INSERT INTO sync_feed(epoch,entity,entity_key,revision,operation,row_json,deleted_at,recorded_at)
  VALUES((SELECT epoch FROM sync_metadata WHERE id=1),NEW.entity,NEW.entity_key,NEW.revision,
    CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'delete' END,
    CASE WHEN NEW.deleted_at IS NULL THEN (SELECT json_object('id',id,'title',title,'notes',notes,'status',status,'due_date',due_date,'due_all_day',CASE due_all_day WHEN 1 THEN json('true') WHEN 0 THEN json('false') ELSE due_all_day END,'recurrence',recurrence,'created_at',created_at,'updated_at',updated_at,'defer_until',defer_until,'defer_kind',defer_kind,'task_type',task_type,'project_id',project_id,'kickoff_note',kickoff_note,'session_log',session_log,'focused_until',focused_until,'duty_id',duty_id,'occurrence_at',occurrence_at,'available_from',available_from,'deadline',deadline) FROM tasks WHERE id=NEW.entity_key) ELSE 'null' END,
    NEW.deleted_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

DROP TRIGGER IF EXISTS sync_task_update;
CREATE TRIGGER sync_task_update AFTER UPDATE ON entity_versions
WHEN NEW.entity='task'
BEGIN
  SELECT RAISE(ABORT,'Sync metadata missing or live source row missing.')
  WHERE NOT EXISTS(SELECT 1 FROM sync_metadata WHERE id=1)
    OR (NEW.deleted_at IS NULL AND (SELECT json_object('id',id,'title',title,'notes',notes,'status',status,'due_date',due_date,'due_all_day',CASE due_all_day WHEN 1 THEN json('true') WHEN 0 THEN json('false') ELSE due_all_day END,'recurrence',recurrence,'created_at',created_at,'updated_at',updated_at,'defer_until',defer_until,'defer_kind',defer_kind,'task_type',task_type,'project_id',project_id,'kickoff_note',kickoff_note,'session_log',session_log,'focused_until',focused_until,'duty_id',duty_id,'occurrence_at',occurrence_at,'available_from',available_from,'deadline',deadline) FROM tasks WHERE id=NEW.entity_key) IS NULL);
  INSERT INTO sync_feed(epoch,entity,entity_key,revision,operation,row_json,deleted_at,recorded_at)
  VALUES((SELECT epoch FROM sync_metadata WHERE id=1),NEW.entity,NEW.entity_key,NEW.revision,
    CASE WHEN NEW.deleted_at IS NULL THEN 'upsert' ELSE 'delete' END,
    CASE WHEN NEW.deleted_at IS NULL THEN (SELECT json_object('id',id,'title',title,'notes',notes,'status',status,'due_date',due_date,'due_all_day',CASE due_all_day WHEN 1 THEN json('true') WHEN 0 THEN json('false') ELSE due_all_day END,'recurrence',recurrence,'created_at',created_at,'updated_at',updated_at,'defer_until',defer_until,'defer_kind',defer_kind,'task_type',task_type,'project_id',project_id,'kickoff_note',kickoff_note,'session_log',session_log,'focused_until',focused_until,'duty_id',duty_id,'occurrence_at',occurrence_at,'available_from',available_from,'deadline',deadline) FROM tasks WHERE id=NEW.entity_key) ELSE 'null' END,
    NEW.deleted_at,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
