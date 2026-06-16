import { describe, test, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { resetIdb } from '../helpers/idb';
import { closeDb } from '../../src/idb/db';
import { idbGetPendingOps } from '../../src/idb/pendingOps';

// Open the DB at an explicit version without going through the production getDB()
// singleton. This lets us seed a pre-v4 state that triggers the v4 migration.
function openRaw(name: string, version: number, setup: (db: IDBDatabase, tx: IDBTransaction) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, version);
    req.onupgradeneeded = () => {
      const db = req.result;
      const tx = req.transaction!;
      // Create all stores so the DB is structurally valid at this version.
      if (!db.objectStoreNames.contains('tasks'))
        db.createObjectStore('tasks', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('pending_ops'))
        db.createObjectStore('pending_ops', { keyPath: 'id', autoIncrement: true });
      if (!db.objectStoreNames.contains('projects'))
        db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('links'))
        db.createObjectStore('links', { keyPath: ['from_task_id', 'to_task_id', 'link_type'] });
      setup(db, tx);
    };
    req.onsuccess = () => { req.result.close(); resolve(); };
    req.onerror = () => reject(req.error);
  });
}

function putInto(tx: IDBTransaction, store: string, record: object): void {
  tx.objectStore(store).put(record);
}

beforeEach(async () => {
  closeDb();
  await resetIdb();
});

describe('v3 → v4 migration', () => {
  test('translates all legacy op patterns', async () => {
    // Seed a v3 DB with one legacy op for each supported pattern.
    await openRaw('alongside', 3, (_, tx) => {
      const ops = [
        { method: 'POST', path: '/api/tasks', body: { title: 'New task' }, local_id: 't_local1', created_at: '2026-01-01T00:00:00.000Z' },
        { method: 'PATCH', path: '/api/tasks/t_abc001', body: { title: 'Updated' }, local_id: null, created_at: '2026-01-01T00:00:00.000Z' },
        { method: 'POST', path: '/api/tasks/t_abc001/complete', body: null, local_id: null, created_at: '2026-01-01T00:00:00.000Z' },
        { method: 'DELETE', path: '/api/tasks/t_abc001', body: null, local_id: null, created_at: '2026-01-01T00:00:00.000Z' },
        { method: 'POST', path: '/api/tasks/links', body: { from_task_id: 't_a00001', to_task_id: 't_b00001', link_type: 'blocks' }, local_id: null, created_at: '2026-01-01T00:00:00.000Z' },
        { method: 'DELETE', path: '/api/tasks/links', body: { from_task_id: 't_a00001', to_task_id: 't_b00001', link_type: 'blocks' }, local_id: null, created_at: '2026-01-01T00:00:00.000Z' },
      ];
      for (const op of ops) putInto(tx, 'pending_ops', op);
    });

    // Opening via getDB() bumps to v4 and runs the migration.
    const ops = await idbGetPendingOps();

    expect(ops).toHaveLength(6);

    const create = ops.find(o => o.op === 'task.create');
    expect(create).toBeDefined();
    if (create?.op === 'task.create') {
      expect(create.localId).toBe('t_local1');
      expect(create.body.title).toBe('New task');
    }

    const update = ops.find(o => o.op === 'task.update');
    expect(update).toBeDefined();
    if (update?.op === 'task.update') {
      expect(update.taskId).toBe('t_abc001');
      expect(update.body.title).toBe('Updated');
    }

    const complete = ops.find(o => o.op === 'task.complete');
    expect(complete).toBeDefined();
    if (complete?.op === 'task.complete') {
      expect(complete.taskId).toBe('t_abc001');
    }

    const del = ops.find(o => o.op === 'task.delete');
    expect(del).toBeDefined();
    if (del?.op === 'task.delete') {
      expect(del.taskId).toBe('t_abc001');
    }

    const linkCreate = ops.find(o => o.op === 'link.create');
    expect(linkCreate).toBeDefined();
    if (linkCreate?.op === 'link.create') {
      expect(linkCreate.body.from_task_id).toBe('t_a00001');
    }

    const linkDelete = ops.find(o => o.op === 'link.delete');
    expect(linkDelete).toBeDefined();

    // All migrated ops start with 0 attempts
    for (const op of ops) {
      expect(op.attempts).toBe(0);
    }
  });

  test('unrecognizable op is deleted', async () => {
    await openRaw('alongside', 3, (_, tx) => {
      putInto(tx, 'pending_ops', {
        method: 'PUT',
        path: '/api/unknown/endpoint',
        body: {},
        local_id: null,
        created_at: '2026-01-01T00:00:00.000Z',
      });
      // A valid op alongside the junk one
      putInto(tx, 'pending_ops', {
        method: 'DELETE',
        path: '/api/tasks/t_abc001',
        body: null,
        local_id: null,
        created_at: '2026-01-01T00:00:00.000Z',
      });
    });

    const ops = await idbGetPendingOps();
    // Only the valid op survives
    expect(ops).toHaveLength(1);
    expect(ops[0]!.op).toBe('task.delete');
  });

  test('already-v4-format ops are left unchanged by migration', async () => {
    // Directly seed a v3 DB with a record that already has the new op shape.
    // (This simulates a partial migration or a future state.)
    await openRaw('alongside', 3, (_, tx) => {
      putInto(tx, 'pending_ops', {
        created_at: '2026-01-01T00:00:00.000Z',
        attempts: 0,
        op: 'task.delete',
        taskId: 't_abc001',
      });
    });

    const ops = await idbGetPendingOps();
    expect(ops).toHaveLength(1);
    expect(ops[0]!.op).toBe('task.delete');
    if (ops[0]!.op === 'task.delete') {
      expect(ops[0]!.taskId).toBe('t_abc001');
    }
  });

  test('v3 defer-shape migration composes with v4 op migration', async () => {
    // Simulate a v2-era record that needed both the snoozed_until→defer_kind
    // transformation (v3) AND the legacy op translation (v4).
    // Seed at v2 so both v3 and v4 migrations run on open (oldVersion=2).
    // The v4 translateLegacyPendingOp applies the body migration inline to
    // handle the case where v3 and v4 cursors run concurrently.
    await openRaw('alongside', 2, (_, tx) => {
      // A task PATCH with the old snoozed_until body (v2 era)
      putInto(tx, 'pending_ops', {
        method: 'PATCH',
        path: '/api/tasks/t_abc001',
        body: { snoozed_until: '2026-12-01T00:00:00.000Z' },
        local_id: null,
        created_at: '2026-01-01T00:00:00.000Z',
      });
    });

    const ops = await idbGetPendingOps();
    // After v3 migration, the body's snoozed_until is rewritten to defer_until.
    // After v4 migration, the op itself is translated to task.update shape.
    expect(ops).toHaveLength(1);
    const op = ops[0]!;
    expect(op.op).toBe('task.update');
    if (op.op === 'task.update') {
      expect(op.taskId).toBe('t_abc001');
      // v3 migration should have converted snoozed_until → defer_until
      expect((op.body as Record<string, unknown>).defer_until).toBe('2026-12-01T00:00:00.000Z');
      expect((op.body as Record<string, unknown>).defer_kind).toBe('until');
      expect((op.body as Record<string, unknown>).snoozed_until).toBeUndefined();
    }
  });
});
