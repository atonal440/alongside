import { parseWorkspaceSnapshot, type WorkspaceSnapshot } from '@shared/wire/sync';

// Fixed identifiers only, never caller-provided SQL. Keep explicit row columns
// so obsolete upgrade-only columns (tasks.session_id) cannot cross the boundary.
const sources = [
  ['task', 'tasks', 'id', 'id title notes status due_date due_all_day recurrence created_at updated_at defer_until defer_kind task_type project_id kickoff_note session_log focused_until duty_id occurrence_at'],
  ['project', 'projects', 'id', 'id title notes kickoff_note status created_at updated_at'],
  ['link', 'task_links', 'json_array(from_task_id,to_task_id,link_type)', 'from_task_id to_task_id link_type'],
  ['duty', 'duties', 'id', 'id title notes kickoff_note task_type project_id rrule dtstart timezone status catch_up last_spawned_at next_occurrence_at created_at updated_at'],
  ['preference', 'user_preferences', 'key', 'key value'],
  ['action_log', 'action_log', 'CAST(id AS TEXT)', 'id tool_name task_id duty_id title detail created_at'],
  ['command_audit', 'command_audit', 'command_id', 'command_id actor reason changes_json created_at'],
  ['planning_settings', 'planning_settings', "'workspace'", 'id timezone buffer_minutes revision created_at updated_at'],
] as const;
const rowCases = sources.map(([entity, table, key, columns]) => {
  const fields = columns.split(' ').flatMap(column => [`'${column}'`, column === 'due_all_day'
    ? "CASE due_all_day WHEN 1 THEN json('true') WHEN 0 THEN json('false') ELSE due_all_day END" : column]);
  if (entity === 'planning_settings') fields.push("'working_hours'", `json((SELECT COALESCE(json_group_array(json_object('weekday',weekday,'start_time',start_time,'end_time',end_time)),'[]')
    FROM (SELECT weekday,start_time,end_time FROM planning_working_hours WHERE settings_id=1 ORDER BY weekday,start_time)))`);
  return `WHEN '${entity}' THEN (SELECT json_object(${fields.join(',')}) FROM ${table} WHERE ${key}=versions.entity_key)`;
});
const snapshotQuery = `SELECT json_object('contractVersion',2,
  'cursor',json_object('epoch',epoch,'sequence',watermark),
  'structuralRevision',(SELECT structural_revision FROM workspace_versions WHERE id=1),
  'entities',json((SELECT COALESCE(json_group_array(json_object('entity',entity,'key',key,'revision',revision,'deletedAt',deleted_at,'row',json(row_json))),'[]')
    FROM (SELECT entity,entity_key AS key,revision,deleted_at,
      CASE WHEN deleted_at IS NOT NULL THEN 'null' ELSE CASE entity ${rowCases.join(' ')} END END AS row_json
      FROM (SELECT * FROM entity_versions UNION ALL SELECT * FROM sync_aux_versions) AS versions
      ORDER BY entity,entity_key)))) AS snapshot_json
  FROM sync_metadata WHERE id=1`;

/** One SQL statement captures all rows, ledgers and the cursor at one instant. */
export async function readWorkspaceSnapshot(db: D1Database): Promise<WorkspaceSnapshot> {
  const result = await db.prepare(snapshotQuery).first<{ snapshot_json: string }>();
  if (!result) throw new Error('Workspace sync metadata is missing.');
  const parsed = parseWorkspaceSnapshot(JSON.parse(result.snapshot_json));
  if (!parsed.ok) throw new Error(`Workspace snapshot failed validation: ${JSON.stringify(parsed.error)}`);
  return parsed.value;
}
