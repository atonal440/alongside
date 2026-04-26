import type { PendingOp } from '@shared/types';
import { getDB } from './db';

export async function idbGetPendingOps(): Promise<PendingOp[]> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction('pending_ops', 'readonly').objectStore('pending_ops').getAll();
    req.onsuccess = () => resolve(req.result as PendingOp[]);
    req.onerror = () => reject(req.error);
  });
}

export async function idbQueueOp(
  method: string,
  path: string,
  body: unknown,
  localId: string | null = null,
): Promise<void> {
  const op: PendingOp = {
    method,
    path,
    body,
    local_id: localId,
    created_at: new Date().toISOString(),
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
