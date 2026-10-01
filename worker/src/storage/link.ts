import { entityStorageKey, parseLinkSnapshot, type LinkKey, type LinkSnapshot } from '@shared/wire/versions';
export interface LinkPlanningContext {
  current: LinkSnapshot; reverse: LinkSnapshot | null;
  fromExists: boolean; toExists: boolean; wouldCycle: boolean;
}
const json = "json_object('from_task_id',from_task_id,'to_task_id',to_task_id,'link_type',link_type)";
/** One SQL snapshot covers the edge, ledger, endpoints, reverse edge and cycle. */
export async function readLinkContext(d1: D1Database, key: LinkKey): Promise<LinkPlanningContext> {
  const reverseKey: LinkKey = { ...key, from: key.to, to: key.from };
  const stored = await d1.prepare(`WITH target(from_id,to_id,link_type,entity_key,reverse_key) AS (VALUES(?,?,?,?,?))
    SELECT w.structural_revision,e.revision,e.deleted_at,r.revision AS reverse_revision,r.deleted_at AS reverse_deleted_at,
      (SELECT ${json} FROM task_links WHERE from_task_id=t.from_id AND to_task_id=t.to_id AND link_type=t.link_type) AS row_json,
      CASE WHEN t.link_type='related' THEN (SELECT ${json} FROM task_links WHERE from_task_id=t.to_id AND to_task_id=t.from_id AND link_type='related') ELSE NULL END AS reverse_json,
      EXISTS(SELECT 1 FROM tasks WHERE id=t.from_id) AS from_exists,
      EXISTS(SELECT 1 FROM tasks WHERE id=t.to_id) AS to_exists,
      CASE WHEN t.link_type='blocks' THEN EXISTS(
        WITH RECURSIVE downstream(id) AS (
          SELECT to_task_id FROM task_links WHERE from_task_id=t.to_id AND link_type='blocks'
          UNION SELECT l.to_task_id FROM task_links l JOIN downstream d ON l.from_task_id=d.id WHERE l.link_type='blocks'
        ) SELECT 1 FROM downstream WHERE id=t.from_id
      ) ELSE 0 END AS would_cycle
    FROM workspace_versions w CROSS JOIN target t
    LEFT JOIN entity_versions e ON e.entity='link' AND e.entity_key=t.entity_key
    LEFT JOIN entity_versions r ON r.entity='link' AND r.entity_key=t.reverse_key WHERE w.id=1`)
    .bind(key.from,key.to,key.linkType,entityStorageKey(key),entityStorageKey(reverseKey))
    .first<{ structural_revision: number; revision: number|null; deleted_at: string|null; row_json: string|null;
      reverse_revision: number|null; reverse_deleted_at: string|null; reverse_json: string|null;
      from_exists: number; to_exists: number; would_cycle: number }>();
  if (!stored) throw new Error('Workspace singleton is missing.');
  const snapshot = (selected: LinkKey, row: string|null, revision: number|null, deletedAt: string|null): LinkSnapshot => {
    const parsed = parseLinkSnapshot({ contractVersion: 2, key: selected, row: row === null ? null : JSON.parse(row),
      structuralRevision: stored.structural_revision, version: revision === null ? null : { revision, deletedAt } });
    if (!parsed.ok) throw new Error('Stored link snapshot failed validation.'); return parsed.value;
  };
  const flag = (value: number): boolean => { if (value !== 0 && value !== 1) throw new Error('Invalid stored link context flag.'); return value === 1; };
  return { current: snapshot(key,stored.row_json,stored.revision,stored.deleted_at),
    reverse: stored.reverse_json === null ? null : snapshot(reverseKey,stored.reverse_json,stored.reverse_revision,stored.reverse_deleted_at),
    fromExists: flag(stored.from_exists), toExists: flag(stored.to_exists), wouldCycle: flag(stored.would_cycle) };
}
