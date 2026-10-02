import { parseRetainedOp, type RetainedOp, type RetainedReason } from '../api/retainedOps';
import type { PendingOp } from '../api/pendingOps';
import { getDB } from './db';

function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return getDB().then(db => new Promise<T>((resolve, reject) => {
    const tx = db.transaction('retained_ops', mode);
    const req = work(tx.objectStore('retained_ops'));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

/** Retain a refused op (without its pending-queue id) with the reason it was refused. */
export async function idbRetainOp(op: PendingOp, reason: RetainedReason): Promise<void> {
  const { id: _queueId, ...rest } = op;
  await run('readwrite', store => store.put({ retained_at: new Date().toISOString(), reason, op: rest }));
}

export async function idbGetRetainedOps(): Promise<RetainedOp[]> {
  const raw = await run<unknown[]>('readonly', store => store.getAll());
  return raw.flatMap(item => {
    const parsed = parseRetainedOp(item);
    if (!parsed.ok) {
      console.warn('[idb] malformed retained op skipped', item, parsed.error);
      return [];
    }
    return [parsed.value];
  });
}

export async function idbDeleteRetainedOp(id: number): Promise<void> {
  await run('readwrite', store => store.delete(id));
}

export async function idbClearRetainedOps(): Promise<void> {
  await run('readwrite', store => store.clear());
}
