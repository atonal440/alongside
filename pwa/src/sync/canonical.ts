import type { Result } from '@shared/result';
import { err, ok } from '@shared/result';
import type { ValidationError } from '@shared/parse';
import type { SyncCursor } from '@shared/wire/syncCursor';
import { findDanglingReference, type SyncEntity, type WorkspaceDelta, type WorkspaceSnapshot } from '@shared/wire/sync';

/**
 * The server's last committed workspace as the PWA knows it: one versioned image
 * per entity identity (live rows and retained tombstones) plus the cursor it is
 * current through. It is a pure cache of server state; optimistic local intent
 * stays in the pending-op queue and is overlaid on top by later increments.
 *
 * The structural revision is deliberately absent: the delta contract never
 * refreshes it, so any stored copy would be stale after the first write. Read it
 * from an entity-version lookup when a structural command needs it.
 */
export interface CanonicalWorkspace {
  cursor: SyncCursor;
  entities: ReadonlyMap<string, SyncEntity>;
}

export const entityId = (image: Pick<SyncEntity, 'entity' | 'key'>): string => `${image.entity}:${image.key}`;

function problem(code: string, message: string): ValidationError[] {
  return [{ path: [], code, message }];
}

export const danglingReference = (entities: ReadonlyMap<string, SyncEntity>): string | null => findDanglingReference(entities.values());

export function canonicalFromSnapshot(snapshot: WorkspaceSnapshot): CanonicalWorkspace {
  return {
    cursor: snapshot.cursor,
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
  return ok({ cursor, entities });
}

/** Images that differ from the base; the incremental IDB commit writes exactly these. */
export function changedImages(base: CanonicalWorkspace, next: CanonicalWorkspace): SyncEntity[] {
  return [...next.entities.entries()].filter(([id, image]) => base.entities.get(id) !== image).map(([, image]) => image);
}
