import { parseWorkspaceSnapshot, parseWorkspaceDelta, parseSyncCursor, type WorkspaceSnapshot, type WorkspaceDelta, type WorkspaceDeltaInput } from '@shared/wire/sync';
import { parseRevision } from '@shared/parse';
import { CommandError } from '../domain/commands';

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
// Separate result rows avoid D1's 2 MB single-row/value limit. Repeating cursor
// metadata on each row keeps the same single-statement consistency guarantee.
// The LEFT JOIN supplies one metadata-only row for an empty workspace.
const snapshotQuery = `SELECT sync_metadata.epoch,sync_metadata.watermark,
  (SELECT structural_revision FROM workspace_versions WHERE id=1) AS structural_revision,
  versions.entity,versions.entity_key,versions.revision,versions.deleted_at,
  CASE WHEN versions.deleted_at IS NOT NULL THEN 'null' ELSE CASE versions.entity ${rowCases.join(' ')} END END AS row_json
  FROM sync_metadata LEFT JOIN (SELECT * FROM entity_versions UNION ALL SELECT * FROM sync_aux_versions) AS versions ON 1
  WHERE sync_metadata.id=1 ORDER BY versions.entity,versions.entity_key`;

/** One SQL statement captures all rows, ledgers and the cursor at one instant. */
export async function readWorkspaceSnapshot(db: D1Database): Promise<WorkspaceSnapshot> {
  const result = await db.prepare(snapshotQuery).all<{
    epoch: number; watermark: number; structural_revision: number;
    entity: string | null; entity_key: string | null; revision: number | null; deleted_at: string | null; row_json: string | null;
  }>();
  const metadata = result.results[0];
  if (!metadata) throw new Error('Workspace sync metadata is missing.');
  const entities = result.results.filter(row => row.entity !== null).map(row => ({
    entity: row.entity, key: row.entity_key, revision: row.revision, deletedAt: row.deleted_at,
    row: row.row_json === null ? null : JSON.parse(row.row_json),
  }));
  const parsed = parseWorkspaceSnapshot({ contractVersion: 2,
    cursor: { epoch: metadata.epoch, sequence: metadata.watermark },
    structuralRevision: metadata.structural_revision, entities });
  if (!parsed.ok) throw new Error(`Workspace snapshot failed validation: ${JSON.stringify(parsed.error)}`);
  return parsed.value;
}

// Cursor metadata and the bounded historical images share this SQL snapshot.
// A continuation uses the first page's upper watermark, never today's rows.
const deltaQuery = `SELECT sync_metadata.epoch,sync_metadata.watermark,sync_metadata.retention_floor,
  history.seq,history.entity,history.entity_key,history.revision,history.deleted_at,history.row_json
  FROM sync_metadata LEFT JOIN (
    SELECT seq,entity,entity_key,revision,deleted_at,row_json FROM sync_feed
    WHERE epoch=(SELECT epoch FROM sync_metadata WHERE id=1) AND seq > ?
      AND seq <= COALESCE(?,(SELECT watermark FROM sync_metadata WHERE id=1))
    ORDER BY seq LIMIT ?
  ) AS history ON 1 WHERE sync_metadata.id=1 ORDER BY history.seq`;

export async function readWorkspaceDelta(db: D1Database, input: WorkspaceDeltaInput): Promise<WorkspaceDelta> {
  const limit = input.limit ?? 100;
  const result = await db.prepare(deltaQuery).bind(input.cursor.sequence, input.watermark?.sequence ?? null, limit + 1)
    .all<{ epoch: number; watermark: number; retention_floor: number;
      seq: number | null; entity: string | null; entity_key: string | null; revision: number | null; deleted_at: string | null; row_json: string | null }>();
  const metadata = result.results[0];
  if (!metadata) throw new Error('Workspace sync metadata is missing.');
  const current = parseSyncCursor({ epoch: metadata.epoch, sequence: metadata.watermark });
  const floor = parseRevision(metadata.retention_floor);
  if (!current.ok || !floor.ok) throw new Error('Workspace sync metadata failed validation.');
  const reason = input.cursor.epoch !== current.value.epoch ? 'epoch_changed'
    : input.cursor.sequence < floor.value ? 'history_expired'
    : input.cursor.sequence > current.value.sequence ? 'cursor_ahead'
    : input.watermark !== undefined && input.watermark.sequence > current.value.sequence ? 'watermark_ahead' : null;
  if (reason !== null) throw new CommandError({ code: 'sync_reset_required', path: ['cursor'],
    message: 'This sync cursor cannot resume against the current workspace history.', retryable: false,
    recoveryHint: 'Discard staged delta pages, fetch a fresh workspace snapshot and rebase retained local intentions before writing.',
    syncReset: { reason, currentCursor: current.value, retentionFloor: floor.value },
  }, 409);
  const watermark = input.watermark ?? current.value;
  const raw = result.results.filter(row => row.seq !== null);
  const hasMore = raw.length > limit;
  const changes = raw.slice(0, limit).map(row => ({ sequence: row.seq, entity: {
    entity: row.entity, key: row.entity_key, revision: row.revision, deletedAt: row.deleted_at,
    row: row.row_json === null ? null : JSON.parse(row.row_json),
  } }));
  // Validate every image and the sequence relationship before using a cursor.
  const sequence = hasMore ? changes.at(-1)?.sequence : watermark.sequence;
  const parsed = parseWorkspaceDelta({ contractVersion: 2, from: input.cursor, watermark,
    cursor: { epoch: current.value.epoch, sequence }, hasMore, changes });
  if (!parsed.ok) throw new Error(`Workspace delta failed validation: ${JSON.stringify(parsed.error)}`);
  return parsed.value;
}
