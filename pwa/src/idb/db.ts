const IDB_NAME = 'alongside';
const IDB_VERSION = 2;

let _db: IDBDatabase | null = null;

export function getDB(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
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
    };
    req.onsuccess = () => {
      _db = req.result;
      resolve(_db);
    };
    req.onerror = () => reject(req.error);
  });
}
