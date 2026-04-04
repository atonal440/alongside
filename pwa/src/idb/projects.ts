import type { Project } from '@shared/types';
import { getDB } from './db';

export async function idbGetAllProjects(): Promise<Project[]> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction('projects', 'readonly').objectStore('projects').getAll();
    req.onsuccess = () => resolve(req.result as Project[]);
    req.onerror = () => reject(req.error);
  });
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
