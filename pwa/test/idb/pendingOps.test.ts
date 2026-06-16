import { describe, test, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { resetIdb } from '../helpers/idb';
import { closeDb } from '../../src/idb/db';
import { idbQueueOp, idbGetPendingOps, idbDeletePendingOp, idbClearPendingOps } from '../../src/idb/pendingOps';

beforeEach(async () => {
  closeDb();
  await resetIdb();
});

describe('idbQueueOp / idbGetPendingOps', () => {
  test('enqueue a task.create op and read it back', async () => {
    await idbQueueOp({ op: 'task.create', localId: 't_local1', body: { title: 'Buy milk' } });
    const ops = await idbGetPendingOps();
    expect(ops).toHaveLength(1);
    const op = ops[0]!;
    expect(op.op).toBe('task.create');
    if (op.op === 'task.create') {
      expect(op.localId).toBe('t_local1');
      expect(op.body.title).toBe('Buy milk');
    }
    expect(op.attempts).toBe(0);
    expect(typeof op.created_at).toBe('string');
    expect(typeof op.id).toBe('number');
  });

  test('enqueue multiple ops, reads preserve order', async () => {
    await idbQueueOp({ op: 'task.create', localId: 't_a00001', body: { title: 'First' } });
    await idbQueueOp({ op: 'task.complete', taskId: 't_b00001' });
    await idbQueueOp({ op: 'link.create', body: { from_task_id: 't_a00001', to_task_id: 't_b00001', link_type: 'blocks' } });
    const ops = await idbGetPendingOps();
    expect(ops).toHaveLength(3);
    expect(ops[0]!.op).toBe('task.create');
    expect(ops[1]!.op).toBe('task.complete');
    expect(ops[2]!.op).toBe('link.create');
  });

  test('malformed record is skipped with a console.warn', async () => {
    // Seed a malformed record directly
    await idbQueueOp({ op: 'task.delete', taskId: 't_abc001' });

    // Plant a malformed record by directly using the DB
    const { getDB } = await import('../../src/idb/db');
    const db = await getDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('pending_ops', 'readwrite');
      tx.objectStore('pending_ops').put({
        id: 9999,
        created_at: '2026-01-01T00:00:00.000Z',
        attempts: 0,
        op: 'not.a.real.op',
        garbage: true,
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ops = await idbGetPendingOps();

    // Only the valid op is returned; the malformed one is skipped
    expect(ops).toHaveLength(1);
    expect(ops[0]!.op).toBe('task.delete');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  test('idbDeletePendingOp removes by id', async () => {
    await idbQueueOp({ op: 'task.complete', taskId: 't_abc001' });
    const [op] = await idbGetPendingOps();
    await idbDeletePendingOp(op!.id!);
    const remaining = await idbGetPendingOps();
    expect(remaining).toHaveLength(0);
  });

  test('idbClearPendingOps empties the store', async () => {
    await idbQueueOp({ op: 'task.delete', taskId: 't_a00001' });
    await idbQueueOp({ op: 'task.delete', taskId: 't_b00001' });
    await idbClearPendingOps();
    const ops = await idbGetPendingOps();
    expect(ops).toHaveLength(0);
  });
});
