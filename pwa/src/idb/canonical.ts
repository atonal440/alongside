import * as v from 'valibot';
import { parseSchema } from '@shared/parse';
import { SyncCursorSchema, type SyncCursor } from '@shared/wire/syncCursor';
import { SyncEntitySchema, type SyncEntity } from '@shared/wire/sync';
import { danglingReference, entityId, type CanonicalWorkspace } from '../sync/canonical';
import { getDB } from './db';

const META_KEY = 'workspace';
const STORES = ['canonical_meta', 'canonical_entities'];
/** `source` ties the cache to one server (the API base); another server's cache is a miss. */
const MetaSchema = v.strictObject({ id: v.literal(META_KEY), source: v.string(), cursor: SyncCursorSchema });

/** Another pull committed between this pull's read and its commit. */
export class StaleCanonicalError extends Error {
  constructor() { super('Canonical workspace changed since it was read.'); this.name = 'StaleCanonicalError'; }
}

/**
 * Run one atomic read/write transaction. Any synchronous throw, request error or
 * explicit `fail` aborts the whole transaction (so queued puts and clears roll
 * back) and rejects with the real cause.
 */
function transact(mode: IDBTransactionMode, work: (tx: IDBTransaction, fail: (error: unknown) => void) => void): Promise<void> {
  return getDB().then(db => new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORES, mode);
    let failure: unknown;
    const fail = (error: unknown) => { failure ??= error; try { tx.abort(); } catch { /* already finished */ } };
    tx.oncomplete = () => resolve();
    tx.onerror = event => { failure ??= (event.target as IDBRequest | null)?.error; };
    tx.onabort = () => reject(failure ?? tx.error ?? new Error('Canonical transaction aborted.'));
    try { work(tx, fail); } catch (error) { fail(error); }
  }));
}

async function readStores(read: (tx: IDBTransaction) => void): Promise<void> {
  await transact('readonly', read);
}

/** Metadata only: a cheap check that the stored cursor still matches an in-memory copy. */
export async function idbReadCanonicalCursor(source: string): Promise<SyncCursor | null> {
  let raw: unknown;
  await readStores(tx => { tx.objectStore('canonical_meta').get(META_KEY).onsuccess = event => { raw = (event.target as IDBRequest).result; }; });
  if (raw === undefined) return null;
  const meta = parseSchema(MetaSchema, raw);
  return meta.ok && meta.value.source === source ? meta.value.cursor : null;
}

/**
 * Read the canonical workspace, parsing every record at the IDB boundary. The
 * store is a derived cache of server state, so anything corrupt, partial,
 * dangling or from another server yields null (the caller re-bootstraps)
 * instead of repairing in place.
 */
export async function idbReadCanonical(source: string): Promise<CanonicalWorkspace | null> {
  let rawMeta: unknown;
  let rawRows: unknown[] = [];
  await readStores(tx => {
    tx.objectStore('canonical_meta').get(META_KEY).onsuccess = event => { rawMeta = (event.target as IDBRequest).result; };
    tx.objectStore('canonical_entities').getAll().onsuccess = event => { rawRows = (event.target as IDBRequest).result as unknown[]; };
  });
  if (rawMeta === undefined) return null;
  const meta = parseSchema(MetaSchema, rawMeta);
  if (!meta.ok) { console.warn('[idb:canonical] invalid metadata; re-bootstrap required'); return null; }
  if (meta.value.source !== source) return null;
  const entities = new Map<string, SyncEntity>();
  for (const raw of rawRows as { id?: unknown; image?: unknown }[]) {
    const image = parseSchema(SyncEntitySchema, raw.image);
    if (!image.ok || raw.id !== entityId(image.value) || entities.has(raw.id)) { console.warn(`[idb:canonical] invalid entity ${String(raw.id)}; re-bootstrap required`); return null; }
    entities.set(raw.id, image.value);
  }
  const dangling = danglingReference(entities);
  if (dangling) { console.warn(`[idb:canonical] ${dangling} Re-bootstrap required`); return null; }
  return { cursor: meta.value.cursor, entities };
}

const putMeta = (tx: IDBTransaction, source: string, cursor: SyncCursor) => tx.objectStore('canonical_meta').put({ id: META_KEY, source, cursor });

/** Bootstrap/reset: replace everything in one transaction so a reader never sees a mix of epochs. */
export async function idbReplaceCanonical(canonical: CanonicalWorkspace, source: string): Promise<void> {
  await transact('readwrite', tx => {
    const entities = tx.objectStore('canonical_entities');
    entities.clear();
    for (const [id, image] of canonical.entities) entities.put({ id, image });
    putMeta(tx, source, canonical.cursor);
  });
}

/**
 * Complete pull: compare-and-set on the stored cursor, then write only the changed
 * images and the new cursor, all in one transaction. A concurrent pull (another tab)
 * that moved the cursor makes this reject with StaleCanonicalError and write nothing.
 */
export async function idbCommitCanonical(canonical: CanonicalWorkspace, changed: readonly SyncEntity[], source: string, expected: SyncCursor): Promise<void> {
  await transact('readwrite', (tx, fail) => {
    tx.objectStore('canonical_meta').get(META_KEY).onsuccess = event => {
      try {
        const meta = parseSchema(MetaSchema, (event.target as IDBRequest).result);
        if (!meta.ok || meta.value.source !== source || meta.value.cursor.epoch !== expected.epoch || meta.value.cursor.sequence !== expected.sequence) { fail(new StaleCanonicalError()); return; }
        const entities = tx.objectStore('canonical_entities');
        for (const image of changed) entities.put({ id: entityId(image), image });
        putMeta(tx, source, canonical.cursor);
      } catch (error) { fail(error); }
    };
  });
}

export async function idbClearCanonical(): Promise<void> {
  await transact('readwrite', tx => {
    tx.objectStore('canonical_meta').clear();
    tx.objectStore('canonical_entities').clear();
  });
}
