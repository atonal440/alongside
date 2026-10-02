import type { Result } from '@shared/result';
import { err, ok } from '@shared/result';
import type { Revision, ValidationError } from '@shared/parse';
import type { SyncCursor } from '@shared/wire/syncCursor';
import type { SyncEntity, WorkspaceDelta, WorkspaceSnapshot } from '@shared/wire/sync';

/**
 * The server's last committed workspace as the PWA knows it: one versioned image
 * per entity identity (live rows and retained tombstones) plus the cursor it is
 * current through. It is a pure cache of server state; optimistic local intent
 * stays in the pending-op queue and is overlaid on top by later increments.
 */
export interface CanonicalWorkspace {
  cursor: SyncCursor;
  structuralRevision: Revision;
  entities: ReadonlyMap<string, SyncEntity>;
}

export const entityId = (image: Pick<SyncEntity, 'entity' | 'key'>): string => `${image.entity}:${image.key}`;

function problem(code: string, message: string): ValidationError[] {
  return [{ path: [], code, message }];
}

/** Live references must resolve in the final state; historical logs/audit may name deleted entities. */
export function danglingReference(entities: ReadonlyMap<string, SyncEntity>): string | null {
  const live = (entity: string, key: string | null) => key === null || (entities.get(`${entity}:${key}`)?.row ?? null) !== null;
  for (const image of entities.values()) {
    switch (image.entity) {
      case 'task':
        if (image.row === null) break;
        if (!live('project', image.row.project_id)) return `Task ${image.key} references missing project ${image.row.project_id}.`;
        if (!live('duty', image.row.duty_id)) return `Task ${image.key} references missing duty ${image.row.duty_id}.`;
        break;
      case 'duty':
        if (image.row !== null && !live('project', image.row.project_id)) return `Duty ${image.key} references missing project ${image.row.project_id}.`;
        break;
      case 'link':
        if (image.row !== null && (!live('task', image.row.from_task_id) || !live('task', image.row.to_task_id))) return `Link ${image.key} references a missing task.`;
        break;
      default:
        break;
    }
  }
  return null;
}

export function canonicalFromSnapshot(snapshot: WorkspaceSnapshot): CanonicalWorkspace {
  return {
    cursor: snapshot.cursor,
    structuralRevision: snapshot.structuralRevision,
    entities: new Map(snapshot.entities.map(image => [entityId(image), image])),
  };
}

/**
 * Reconcile one complete staged delta pull. Pages may split a source transaction
 * and temporarily dangle references, so nothing is validated until every page is
 * applied; the caller must commit the result atomically or discard it.
 */
export function applyStagedPull(base: CanonicalWorkspace, pages: readonly WorkspaceDelta[]): Result<CanonicalWorkspace, ValidationError[]> {
  const first = pages[0];
  const last = pages[pages.length - 1];
  if (!first || !last) return err(problem('empty_pull', 'A pull needs at least one page.'));
  if (last.hasMore) return err(problem('incomplete_pull', 'The staged pull ended before the fixed watermark.'));
  let cursor = base.cursor;
  const entities = new Map(base.entities);
  for (const page of pages) {
    if (page.from.epoch !== cursor.epoch || page.from.sequence !== cursor.sequence) return err(problem('discontinuous_pull', 'Delta pages must continue exactly from the previous cursor.'));
    if (page.watermark.epoch !== first.watermark.epoch || page.watermark.sequence !== first.watermark.sequence) return err(problem('watermark_moved', 'The fixed watermark changed during the pull.'));
    for (const { entity: image } of page.changes) {
      const id = entityId(image);
      const known = entities.get(id);
      if (known && image.revision <= known.revision) return err(problem('revision_regressed', `${id} arrived at revision ${image.revision}, not above ${known.revision}.`));
      entities.set(id, image);
    }
    cursor = page.cursor;
  }
  const dangling = danglingReference(entities);
  if (dangling) return err(problem('dangling_reference', dangling));
  return ok({ cursor, structuralRevision: base.structuralRevision, entities });
}

/** Images that differ from the base; the incremental IDB commit writes exactly these. */
export function changedImages(base: CanonicalWorkspace, next: CanonicalWorkspace): SyncEntity[] {
  return [...next.entities.entries()].filter(([id, image]) => base.entities.get(id) !== image).map(([, image]) => image);
}
