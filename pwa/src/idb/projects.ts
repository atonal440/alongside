import type { Project } from '@shared/types';
import { getDB } from './db';
import { decodeProjectRows } from './decode';

export async function idbGetAllProjects(): Promise<Project[]> {
  const db = await getDB();
  const raw = await new Promise<unknown[]>((resolve, reject) => {
    const req = db.transaction('projects', 'readonly').objectStore('projects').getAll();
    req.onsuccess = () => resolve(req.result as unknown[]);
    req.onerror = () => reject(req.error);
  });
  const { rows } = decodeProjectRows(raw);
  return rows;
}

export async function idbPutProject(project: Project): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('projects', 'readwrite');
    tx.objectStore('projects').put(project);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function idbClearProjects(): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('projects', 'readwrite');
    tx.objectStore('projects').clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
