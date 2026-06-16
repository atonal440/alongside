const IDB_NAME = 'alongside';
const IDB_VERSION = 4;

let _db: IDBDatabase | null = null;

function migrateLegacyDeferShape(value: Record<string, unknown>): boolean {
  if (!Object.prototype.hasOwnProperty.call(value, 'snoozed_until')) return false;

  const snoozed = value.snoozed_until as string | null | undefined;
  value.defer_until = snoozed ?? null;
  value.defer_kind = snoozed ? 'until' : 'none';
  delete value.snoozed_until;
  return true;
}

function migratePendingOpBody(op: Record<string, unknown>): boolean {
  const body = op.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  return migrateLegacyDeferShape(body as Record<string, unknown>);
}

// v4: translate legacy {method, path, body, local_id} ops to typed PendingOp union.
function translateLegacyPendingOp(record: Record<string, unknown>): Record<string, unknown> | null {
  const method = typeof record.method === 'string' ? record.method : null;
  const path = typeof record.path === 'string' ? record.path : null;
  let body = (record.body ?? {}) as Record<string, unknown>;
  const localId = typeof record.local_id === 'string' ? record.local_id : '';
  const created_at = typeof record.created_at === 'string' ? record.created_at : new Date().toISOString();
  const base = { created_at, attempts: 0 };

  if (!method || !path) return null;

  // Apply the v3 body migration inline in case v3 and v4 cursor loops run
  // concurrently (upgrading v2 → v4 in one step). Ensures translated op bodies
  // always use defer_until/defer_kind rather than the legacy snoozed_until.
  if (Object.prototype.hasOwnProperty.call(body, 'snoozed_until')) {
    const snoozed = body.snoozed_until as string | null;
    body = { ...body, defer_until: snoozed ?? null, defer_kind: snoozed ? 'until' : 'none' };
    delete body.snoozed_until;
  }

  if (method === 'POST' && path === '/api/tasks') {
    return { ...base, op: 'task.create', localId, body };
  }
  if (method === 'POST' && path === '/api/tasks/links') {
    return { ...base, op: 'link.create', body };
  }
  if (method === 'DELETE' && path === '/api/tasks/links') {
    return { ...base, op: 'link.delete', body };
  }

  const completeMatch = /^\/api\/tasks\/([^/]+)\/complete$/.exec(path);
  if (method === 'POST' && completeMatch?.[1]) {
    return { ...base, op: 'task.complete', taskId: completeMatch[1] };
  }

  const taskMatch = /^\/api\/tasks\/([^/]+)$/.exec(path);
  if (method === 'PATCH' && taskMatch?.[1]) {
    return { ...base, op: 'task.update', taskId: taskMatch[1], body };
  }
  if (method === 'DELETE' && taskMatch?.[1]) {
    return { ...base, op: 'task.delete', taskId: taskMatch[1] };
  }

  return null;
}

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
      // place, and rewrite queued offline task updates so unsynced work
      // survives the schema change.
      if (oldVersion < 3) {
        const tx = req.transaction;
        if (tx) {
          const taskStore = tx.objectStore('tasks');
          const cursorReq = taskStore.openCursor();
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (!cursor) return;
            const value = cursor.value as Record<string, unknown>;
            if (migrateLegacyDeferShape(value)) cursor.update(value);
            cursor.continue();
          };
          if (db.objectStoreNames.contains('pending_ops')) {
            const opStore = tx.objectStore('pending_ops');
            const opCursorReq = opStore.openCursor();
            opCursorReq.onsuccess = () => {
              const cursor = opCursorReq.result;
              if (!cursor) return;
              const value = cursor.value as Record<string, unknown>;
              if (migratePendingOpBody(value)) cursor.update(value);
              cursor.continue();
            };
          }
        }
      }
      // v4: translate {method, path, body, local_id} ops to the typed PendingOp union.
      // Ops that match no known pattern are dropped to prevent a permanently wedged queue.
      if (oldVersion < 4) {
        const tx = req.transaction;
        if (tx && db.objectStoreNames.contains('pending_ops')) {
          const opStore = tx.objectStore('pending_ops');
          const cursorReq = opStore.openCursor();
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (!cursor) return;
            const value = cursor.value as Record<string, unknown>;
            // Only touch legacy-format ops (they have 'method' but no 'op').
            if (typeof value.method === 'string') {
              const translated = translateLegacyPendingOp(value);
              if (translated) {
                cursor.update({ ...translated, id: value.id });
              } else {
                console.warn('[idb:v4] unrecognized pending-op shape, removing', value);
                cursor.delete();
              }
            }
            cursor.continue();
          };
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

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
