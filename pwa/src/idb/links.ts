import type { TaskLink } from '@shared/types';
import { getDB } from './db';

export async function idbGetAllLinks(): Promise<TaskLink[]> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction('links', 'readonly').objectStore('links').getAll();
    req.onsuccess = () => resolve(req.result as TaskLink[]);
    req.onerror = () => reject(req.error);
  });
}

export async function idbPutLink(link: TaskLink): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('links', 'readwrite');
    tx.objectStore('links').put(link);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function idbDeleteLink(fromTaskId: string, toTaskId: string, linkType: TaskLink['link_type']): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('links', 'readwrite');
    tx.objectStore('links').delete([fromTaskId, toTaskId, linkType]);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function idbClearLinks(): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('links', 'readwrite');
    tx.objectStore('links').clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
