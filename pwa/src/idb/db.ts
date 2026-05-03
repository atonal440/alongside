const IDB_NAME = 'alongside';
const IDB_VERSION = 3;

let _db: IDBDatabase | null = null;

export function getDB(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const oldVersion = (event as IDBVersionChangeEvent).oldVersion;
      if (!db.objectStoreNames.contains('tasks')) {
        const store = db.createObjectStore('tasks', { keyPath: 'id' });
        store.createIndex('status', 'status');
        store.createIndex('due_date', 'due_date');
      }
      if (!db.objectStoreNames.contains('pending_ops')) {
        db.createObjectStore('pending_ops', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('projects')) {
        db.createObjectStore('projects', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('links')) {
        db.createObjectStore('links', { keyPath: ['from_task_id', 'to_task_id', 'link_type'] });
      }
      // v3: snoozed_until → defer_until + defer_kind. Rewrite each task in
      // place; clear pending_ops since their bodies reference the old field
      // and the worker rejects stale shapes after deploy.
      if (oldVersion < 3) {
        const tx = req.transaction;
        if (tx) {
          const taskStore = tx.objectStore('tasks');
          const cursorReq = taskStore.openCursor();
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (!cursor) return;
            const value = cursor.value as Record<string, unknown>;
            const snoozed = value.snoozed_until as string | null | undefined;
            value.defer_until = snoozed ?? null;
            value.defer_kind = snoozed ? 'until' : 'none';
            delete value.snoozed_until;
            cursor.update(value);
            cursor.continue();
          };
          if (db.objectStoreNames.contains('pending_ops')) {
            tx.objectStore('pending_ops').clear();
          }
        }
      }
    };
    req.onsuccess = () => {
      _db = req.result;
      resolve(_db);
    };
    req.onerror = () => reject(req.error);
  });
}
