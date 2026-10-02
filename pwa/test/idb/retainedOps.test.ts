import { describe, test, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { resetIdb } from '../helpers/idb';
import { closeDb, getDB } from '../../src/idb/db';
import { idbRetainOp, idbGetRetainedOps, idbDeleteRetainedOp, idbClearRetainedOps } from '../../src/idb/retainedOps';
import { parseRetainedOp } from '../../src/api/retainedOps';
import type { PendingOp } from '../../src/api/pendingOps';

beforeEach(async () => { closeDb(); await resetIdb(); });

const op = { id: 7, op: 'task.complete', taskId: 't_abc001', created_at: '2026-10-02T09:00:00.000Z', attempts: 2 } as PendingOp;

describe('retained ops store', () => {
  test('round-trips an op with its reason and drops the queue id', async () => {
    await idbRetainOp(op, { kind: 'rejected', status: 409, message: 'stale' });
    const [got] = await idbGetRetainedOps();
    expect(got).toMatchObject({ reason: { kind: 'rejected', status: 409, message: 'stale' }, op: { op: 'task.complete', taskId: 't_abc001', attempts: 2 } });
    expect(got!.op.id).toBeUndefined();
    expect(typeof got!.id).toBe('number');
  });

  test('delete and clear', async () => {
    await idbRetainOp(op, { kind: 'rejected', status: 400, message: 'a' });
    await idbRetainOp(op, { kind: 'dependency', dependsOn: 't_abc001', message: 'b' });
    const all = await idbGetRetainedOps();
    await idbDeleteRetainedOp(all[0]!.id!);
    expect(await idbGetRetainedOps()).toHaveLength(1);
    await idbClearRetainedOps();
    expect(await idbGetRetainedOps()).toEqual([]);
  });

  test('malformed records are skipped with a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const db = await getDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('retained_ops', 'readwrite');
      tx.objectStore('retained_ops').put({ retained_at: 'x', reason: { kind: 'nope' }, op: {} });
      tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error);
    });
    expect(await idbGetRetainedOps()).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('parser rejects an embedded op that is not a valid pending op', () => {
    expect(parseRetainedOp({ retained_at: 'x', reason: { kind: 'rejected', status: 400, message: 'm' }, op: { op: 'bogus' } }).ok).toBe(false);
  });
});
