import type { Project, Task, TaskLink } from '@shared/types';
import { getDB } from './db';

/**
 * Replace the task/project/link mirror the UI reads with a freshly derived view, in one
 * transaction: a failure leaves the previous mirror intact rather than a half-written one.
 */
export async function idbReplaceView(view: { tasks: readonly Task[]; projects: readonly Project[]; links: readonly TaskLink[] }): Promise<void> {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['tasks', 'projects', 'links'], 'readwrite');
    try {
      const fill = (name: string, rows: readonly unknown[]) => {
        const store = tx.objectStore(name);
        store.clear();
        for (const row of rows) store.put(row);
      };
      fill('tasks', view.tasks);
      fill('projects', view.projects);
      fill('links', view.links);
    } catch (error) {
      try { tx.abort(); } catch { /* already finished */ }
      reject(error);
      return;
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('View transaction aborted.'));
  });
}
