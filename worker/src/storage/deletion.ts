import { parseEntitySnapshot, parseLinkSnapshot, type EntityReadKey, type EntitySnapshot, type LinkSnapshot } from '@shared/wire/versions';
import { PROJECT_COLUMNS, TASK_COLUMNS } from './entity';

export interface DeleteContext {
  current: EntitySnapshot;
  affectedCount: number;
  members: EntitySnapshot[];
  links: LinkSnapshot[];
  hasDutyReferences: boolean;
}
const fields = (columns: string[], alias: string) => columns.map(column => `'${column}',${alias}.${column}`).join(',');
/** A bounded coherent snapshot includes cascaded edges or detached members. */
export async function readDeleteContext(d1: D1Database, key: EntityReadKey): Promise<DeleteContext> {
  const task = key.entity === 'task';
  const table = task ? 'tasks' : 'projects';
  const affected = task ? 'SELECT * FROM task_links WHERE from_task_id=? OR to_task_id=? ORDER BY from_task_id,to_task_id,link_type'
    : 'SELECT * FROM tasks WHERE project_id=? ORDER BY id';
  const effectJson = task ? `json_object('from',a.from_task_id,'to',a.to_task_id,'linkType',a.link_type,'revision',e.revision,'deletedAt',e.deleted_at)`
    : `json_object('id',a.id,'revision',e.revision,'deletedAt',e.deleted_at,'row',json_object(${fields(TASK_COLUMNS,'a')}))`;
  const effectIdentity = task ? "json_array(a.from_task_id,a.to_task_id,a.link_type)" : 'a.id';
  const params = task ? [key.id,key.id,key.id,key.entity,key.id] : [key.id,key.id,key.entity,key.id];
  const stored = await d1.prepare(`WITH affected AS (${affected}), bounded AS (SELECT * FROM affected LIMIT 94)
    SELECT w.structural_revision,e.revision,e.deleted_at,
      (SELECT json_object(${fields(task ? TASK_COLUMNS : PROJECT_COLUMNS,'r')}) FROM ${table} r WHERE r.id=?) AS row_json,
      (SELECT COUNT(*) FROM affected) AS affected_count,
      (SELECT json_group_array(${effectJson}) FROM bounded a LEFT JOIN entity_versions e ON e.entity='${task ? 'link' : 'task'}' AND e.entity_key=${effectIdentity}) AS effects_json,
      ${task ? '0' : '(SELECT EXISTS(SELECT 1 FROM duties WHERE project_id=e.entity_key))'} AS duty_references
    FROM workspace_versions w LEFT JOIN entity_versions e ON e.entity=? AND e.entity_key=? WHERE w.id=1`)
    .bind(...params).first<{structural_revision:number;revision:number|null;deleted_at:string|null;row_json:string|null;affected_count:number;effects_json:string;duty_references:number}>();
  if (!stored || !Number.isSafeInteger(stored.affected_count) || stored.affected_count < 0) throw new Error('Invalid deletion context.');
  const normalizeTask = (row: Record<string, unknown>) => {
    if (![null,0,1].includes(row.due_all_day as number|null)) throw new Error('Invalid stored all-day marker.');
    return { ...row, due_all_day: row.due_all_day === null ? null : row.due_all_day === 1 };
  };
  const snapshot = (selected: EntityReadKey, row: Record<string,unknown>|null, revision: number|null, deletedAt: string|null) => {
    const parsed = parseEntitySnapshot({contractVersion:2,...selected,row:row === null ? null : selected.entity === 'task' ? normalizeTask(row) : row,
      structuralRevision:stored.structural_revision,version:revision === null ? null : {revision,deletedAt}});
    if (!parsed.ok) throw new Error('Invalid stored deletion image.'); return parsed.value;
  };
  const current = snapshot(key,stored.row_json === null ? null : JSON.parse(stored.row_json),stored.revision,stored.deleted_at);
  const effects = JSON.parse(stored.effects_json) as Array<{id:EntityReadKey['id'];from:LinkSnapshot['key']['from'];to:LinkSnapshot['key']['to'];linkType:LinkSnapshot['key']['linkType'];revision:number;deletedAt:string|null;row:Record<string,unknown>}>;
  const links: LinkSnapshot[] = []; const members: EntitySnapshot[] = [];
  for (const effect of effects) {
    if (task) {
      const parsed = parseLinkSnapshot({contractVersion:2,key:{entity:'link',from:effect.from,to:effect.to,linkType:effect.linkType},
        row:{from_task_id:effect.from,to_task_id:effect.to,link_type:effect.linkType},structuralRevision:stored.structural_revision,version:{revision:effect.revision,deletedAt:effect.deletedAt}});
      if (!parsed.ok) throw new Error('Invalid cascaded link snapshot.'); links.push(parsed.value);
    } else members.push(snapshot({entity:'task',id:effect.id as Extract<EntityReadKey,{entity:'task'}>['id']},effect.row,effect.revision,effect.deletedAt));
  }
  if (stored.duty_references !== 0 && stored.duty_references !== 1) throw new Error('Invalid duty-reference flag.');
  return {current,affectedCount:stored.affected_count,members,links,hasDutyReferences:stored.duty_references===1};
}
