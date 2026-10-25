import { type PendingOp, parsePendingOp } from '../api/pendingOps';
import { getDB } from './db';

const parseAll = (raw: unknown[], what: string): PendingOp[] => raw.flatMap(item => {
  const parsed = parsePendingOp(item);
  if (!parsed.ok) {
    console.warn(`[idb] malformed ${what} op skipped`, item, parsed.error);
    return [];
  }
  return [parsed.value];
});

/** Move an accepted command from the queue to the ledger in one transaction, so it is never in both or neither. */
export async function idbLandOp(op: PendingOp): Promise<void> {
  if (op.id === undefined) throw new Error('Only a stored op can land.');
  const id = op.id;
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['pending_ops', 'landed_ops'], 'readwrite');
    tx.objectStore('landed_ops').put(op);
    tx.objectStore('pending_ops').delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function idbGetLandedOps(): Promise<PendingOp[]> {
  return (await idbReadLedgerAndQueue()).landed;
}

/** Both stores in one snapshot, so a command landing meanwhile is seen in exactly one of them. */
export async function idbReadLedgerAndQueue(): Promise<{ landed: PendingOp[]; queue: PendingOp[] }> {
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
  return { landed: parseAll(landed, 'landed'), queue: parseAll(queue, 'pending') };
}

/** Forget landed commands by id. A pull absorbs only the ones that had landed before it began. */
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
