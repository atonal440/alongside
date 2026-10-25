import { type PendingOp, parsePendingOp } from '../api/pendingOps';
import { getDB } from './db';

/** A command the server accepted. `landedAt` is the canonical cursor when it landed, null if there was none. */
export interface LandedOp { op: PendingOp; landedAt: { epoch: number; sequence: number } | null }

/** Move an accepted command from the queue to the ledger in one transaction, so it is never in both or neither. */
export async function idbLandOp(op: PendingOp, landedAt: LandedOp['landedAt']): Promise<void> {
  const id = op.id;
  if (id === undefined) throw new Error('Only a stored op can land.');
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['pending_ops', 'landed_ops'], 'readwrite');
    tx.objectStore('landed_ops').put({ id, landedAt, op });
    tx.objectStore('pending_ops').delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function idbGetLandedOps(): Promise<LandedOp[]> {
  const db = await getDB();
  const raw = await new Promise<unknown[]>((resolve, reject) => {
    const req = db.transaction('landed_ops', 'readonly').objectStore('landed_ops').getAll();
    req.onsuccess = () => resolve(req.result as unknown[]);
    req.onerror = () => reject(req.error);
  });
  return raw.flatMap(item => {
    const record = item as { op?: unknown; landedAt?: LandedOp['landedAt'] };
    const parsed = parsePendingOp(record.op);
    if (!parsed.ok) {
      console.warn('[idb] malformed landed op skipped', item, parsed.error);
      return [];
    }
    return [{ op: parsed.value, landedAt: record.landedAt ?? null }];
  });
}

export async function idbClearLandedOps(): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('landed_ops', 'readwrite');
    tx.objectStore('landed_ops').clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
