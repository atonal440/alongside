import type { Duty } from '@shared/types';
import { getDB } from './db';

export async function idbGetAllDuties(): Promise<Duty[]> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction('duties', 'readonly').objectStore('duties').getAll();
    req.onsuccess = () => resolve(req.result as Duty[]);
    req.onerror = () => reject(req.error);
  });
}

export async function idbPutDuty(duty: Duty): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('duties', 'readwrite');
    tx.objectStore('duties').put(duty);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function idbDeleteDuty(id: string): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('duties', 'readwrite');
    tx.objectStore('duties').delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function idbClearDuties(): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('duties', 'readwrite');
    tx.objectStore('duties').clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
