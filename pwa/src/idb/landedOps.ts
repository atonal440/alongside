import { type PendingOp, parsePendingOp } from '../api/pendingOps';
import { getDB } from './db';

/**
 * A command the server accepted. `revisions` maps each identity it wrote (`task:t_…`, `link:[…]`) to the
 * revision the server gave it; null when the response was unreadable, so absorption can't be proven.
 */
export interface LandedOp { op: PendingOp; revisions: Record<string, number> | null }

const parseRevisions = (value: unknown): Record<string, number> | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  return entries.every(([, revision]) => typeof revision === 'number' && Number.isInteger(revision) && revision >= 0)
    ? Object.fromEntries(entries as [string, number][]) : null;
};

const parseLanded = (raw: unknown[]): LandedOp[] => raw.flatMap(item => {
  const record = (typeof item === 'object' && item !== null ? item : {}) as { op?: unknown; revisions?: unknown };
  const parsed = parsePendingOp(record.op);
  if (!parsed.ok) {
    console.warn('[idb] malformed landed op skipped', item, parsed.error);
    return [];
  }
  return [{ op: parsed.value, revisions: parseRevisions(record.revisions) }];
});

const parseQueue = (raw: unknown[]): PendingOp[] => raw.flatMap(item => {
  const parsed = parsePendingOp(item);
  if (!parsed.ok) {
    console.warn('[idb] malformed pending op skipped', item, parsed.error);
    return [];
  }
  return [parsed.value];
});

/** Move an accepted command from the queue to the ledger in one transaction, so it is never in both or neither. */
export async function idbLandOp(op: PendingOp, revisions: Record<string, number> | null): Promise<void> {
  if (op.id === undefined) throw new Error('Only a stored op can land.');
  const id = op.id;
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['pending_ops', 'landed_ops'], 'readwrite');
    tx.objectStore('landed_ops').put({ id, op, revisions });
    tx.objectStore('pending_ops').delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/** Both stores in one snapshot, so a command landing meanwhile is seen in exactly one of them. */
export async function idbReadLedgerAndQueue(): Promise<{ landed: LandedOp[]; queue: PendingOp[] }> {
  const db = await getDB();
  const [landed, queue] = await new Promise<[unknown[], unknown[]]>((resolve, reject) => {
    const tx = db.transaction(['landed_ops', 'pending_ops'], 'readonly');
    const out: [unknown[], unknown[]] = [[], []];
    tx.objectStore('landed_ops').getAll().onsuccess = event => { out[0] = (event.target as IDBRequest).result as unknown[]; };
    tx.objectStore('pending_ops').getAll().onsuccess = event => { out[1] = (event.target as IDBRequest).result as unknown[]; };
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  return { landed: parseLanded(landed), queue: parseQueue(queue) };
}

export async function idbGetLandedOps(): Promise<LandedOp[]> {
  return (await idbReadLedgerAndQueue()).landed;
}

/** Forget landed commands by id, or all of them without a list. */
export async function idbClearLandedOps(ids?: readonly number[]): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('landed_ops', 'readwrite');
    const store = tx.objectStore('landed_ops');
    if (ids) for (const id of ids) store.delete(id);
    else store.clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
