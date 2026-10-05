-- v16: Task hierarchy (docs/plans/power-user-todo.md, slice 3b). A task may have one parent task:
--   parent_id  the parent task id, null for a top-level task
--   position   sort key among siblings (ascending; null sorts last, then by created_at)
-- Rules the planners enforce (not the schema): the parent is a live task in the same project,
-- the chain has no cycle and is at most 32 deep, a task with open subtasks cannot be completed,
-- and a task with subtasks cannot be deleted or moved to another project. Existing rows keep both null.
-- parent_id deliberately has no foreign key: restore inserts rows in one pass and the planners own integrity.
-- The sync task triggers are recreated so feed images carry the new columns.

ALTER TABLE tasks ADD COLUMN parent_id TEXT;
ALTER TABLE tasks ADD COLUMN position REAL CHECK (position IS NULL OR (typeof(position) IN ('integer','real') AND position = position));

DROP TRIGGER IF EXISTS sync_task_insert;
CREATE TRIGGER sync_task_insert AFTER INSERT ON entity_versions
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

DROP TRIGGER IF EXISTS sync_task_update;
CREATE TRIGGER sync_task_update AFTER UPDATE ON entity_versions
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
