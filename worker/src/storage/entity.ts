import { parseEntitySnapshot, type EntityReadKey, type EntitySnapshot } from '@shared/wire/versions';

export const PROJECT_COLUMNS = ['id', 'title', 'notes', 'kickoff_note', 'status', 'created_at', 'updated_at'];
export const TASK_COLUMNS = ['id', 'title', 'notes', 'status', 'due_date', 'due_all_day', 'recurrence', 'created_at', 'updated_at',
  'defer_until', 'defer_kind', 'task_type', 'project_id', 'kickoff_note', 'session_log', 'focused_until', 'duty_id', 'occurrence_at'];

/** One SQLite snapshot covers content, its ledger revision and the aggregate. */
export async function readEntitySnapshot(d1: D1Database, key: EntityReadKey): Promise<EntitySnapshot> {
  const table = key.entity === 'task' ? 'tasks' : 'projects';
  const columns = key.entity === 'task' ? TASK_COLUMNS : PROJECT_COLUMNS;
  const json = columns.map(column => `'${column}', ${column}`).join(',');
  const stored = await d1.prepare(`SELECT w.structural_revision, e.revision, e.deleted_at,
    (SELECT json_object(${json}) FROM ${table} WHERE id=?) AS row_json
    FROM workspace_versions w LEFT JOIN entity_versions e ON e.entity=? AND e.entity_key=? WHERE w.id=1`)
    .bind(key.id, key.entity, key.id).first<{ structural_revision: number; revision: number | null; deleted_at: string | null; row_json: string | null }>();
  if (!stored) throw new Error('Workspace version singleton is missing.');
  let row = stored.row_json === null ? null : JSON.parse(stored.row_json);
  if (row !== null && key.entity === 'task') {
    if (row.due_all_day !== null && row.due_all_day !== 0 && row.due_all_day !== 1) throw new Error('Stored all-day marker failed validation.');
    row = { ...row, due_all_day: row.due_all_day === null ? null : row.due_all_day === 1 };
  }
  const parsed = parseEntitySnapshot({ contractVersion: 2, ...key, structuralRevision: stored.structural_revision, row,
    version: stored.revision === null ? null : { revision: stored.revision, deletedAt: stored.deleted_at },
  });
  if (!parsed.ok) throw new Error('Stored entity snapshot failed validation.');
  return parsed.value;
}
