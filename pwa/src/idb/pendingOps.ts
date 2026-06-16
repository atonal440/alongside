import { type PendingOp, type PendingOpPayload, parsePendingOp } from '../api/pendingOps';
import { getDB } from './db';

export async function idbGetPendingOps(): Promise<PendingOp[]> {
  const db = await getDB();
  const raw = await new Promise<unknown[]>((resolve, reject) => {
    const req = db.transaction('pending_ops', 'readonly').objectStore('pending_ops').getAll();
    req.onsuccess = () => resolve(req.result as unknown[]);
    req.onerror = () => reject(req.error);
  });
  return raw.flatMap(item => {
    const parsed = parsePendingOp(item);
    if (!parsed.ok) {
      console.warn('[idb] malformed pending op skipped', item, parsed.error);
      return [];
    }
    return [parsed.value];
  });
}

export async function idbQueueOp(payload: PendingOpPayload): Promise<void> {
  const op: PendingOp = {
    ...payload,
    created_at: new Date().toISOString(),
    attempts: 0,
  };
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pending_ops', 'readwrite');
    tx.objectStore('pending_ops').put(op);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function idbPutPendingOp(op: PendingOp): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pending_ops', 'readwrite');
    tx.objectStore('pending_ops').put(op);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function idbDeletePendingOp(id: number): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pending_ops', 'readwrite');
    tx.objectStore('pending_ops').delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function idbClearPendingOps(): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('pending_ops', 'readwrite');
    tx.objectStore('pending_ops').clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
