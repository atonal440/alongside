import type { Task } from '@shared/types';
import { getDB } from './db';

export async function idbGetAllTasks(): Promise<Task[]> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction('tasks', 'readonly').objectStore('tasks').getAll();
    req.onsuccess = () => resolve(req.result as Task[]);
    req.onerror = () => reject(req.error);
  });
}

export async function idbPutTask(task: Task): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tasks', 'readwrite');
    tx.objectStore('tasks').put(task);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function idbDeleteTask(id: string): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tasks', 'readwrite');
    tx.objectStore('tasks').delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function idbClearTasks(): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('tasks', 'readwrite');
    tx.objectStore('tasks').clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
