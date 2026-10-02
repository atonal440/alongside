import * as v from 'valibot';
import { RevisionSchema, parseSchema } from '@shared/parse';
import { SyncCursorSchema } from '@shared/wire/syncCursor';
import { SyncEntitySchema, type SyncEntity } from '@shared/wire/sync';
import { danglingReference, entityId, type CanonicalWorkspace } from '../sync/canonical';
import { getDB } from './db';

const META_KEY = 'workspace';
const MetaSchema = v.strictObject({ id: v.literal(META_KEY), cursor: SyncCursorSchema, structuralRevision: RevisionSchema });

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Canonical transaction aborted.'));
  });
}

/**
 * Read the canonical workspace, parsing every record at the IDB boundary. The
 * store is a derived cache of server state, so anything corrupt, partial or
 * dangling yields null (the caller re-bootstraps) instead of repairing in place.
 */
export async function idbReadCanonical(): Promise<CanonicalWorkspace | null> {
  const db = await getDB();
  const tx = db.transaction(['canonical_meta', 'canonical_entities'], 'readonly');
  const metaReq = tx.objectStore('canonical_meta').get(META_KEY);
  const rowsReq = tx.objectStore('canonical_entities').getAll();
  await done(tx);
  if (metaReq.result === undefined) return null;
  const meta = parseSchema(MetaSchema, metaReq.result);
  if (!meta.ok) { console.warn('[idb:canonical] invalid metadata; re-bootstrap required'); return null; }
  const entities = new Map<string, SyncEntity>();
  for (const raw of rowsReq.result as { id?: unknown; image?: unknown }[]) {
    const image = parseSchema(SyncEntitySchema, raw.image);
    if (!image.ok || raw.id !== entityId(image.value) || entities.has(raw.id)) { console.warn('[idb:canonical] invalid entity; re-bootstrap required'); return null; }
    entities.set(raw.id, image.value);
  }
  if (danglingReference(entities)) { console.warn('[idb:canonical] dangling references; re-bootstrap required'); return null; }
  return { cursor: meta.value.cursor, structuralRevision: meta.value.structuralRevision, entities };
}

function putMeta(tx: IDBTransaction, canonical: CanonicalWorkspace): void {
  tx.objectStore('canonical_meta').put({ id: META_KEY, cursor: canonical.cursor, structuralRevision: canonical.structuralRevision });
}

/** Bootstrap/reset: replace everything in one transaction so a reader never sees a mix of epochs. */
export async function idbReplaceCanonical(canonical: CanonicalWorkspace): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['canonical_meta', 'canonical_entities'], 'readwrite');
  const entities = tx.objectStore('canonical_entities');
  entities.clear();
  for (const [id, image] of canonical.entities) entities.put({ id, image });
  putMeta(tx, canonical);
  await done(tx);
}

/** Complete pull: write only the changed images and the new cursor in one transaction. */
export async function idbCommitCanonical(canonical: CanonicalWorkspace, changed: readonly SyncEntity[]): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['canonical_meta', 'canonical_entities'], 'readwrite');
  const entities = tx.objectStore('canonical_entities');
  for (const image of changed) entities.put({ id: entityId(image), image });
  putMeta(tx, canonical);
  await done(tx);
}

export async function idbClearCanonical(): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['canonical_meta', 'canonical_entities'], 'readwrite');
  tx.objectStore('canonical_meta').clear();
  tx.objectStore('canonical_entities').clear();
  await done(tx);
}
