import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { resetIdb } from '../helpers/idb';
import { makeTask } from '../helpers/fixtures';
import { installFetchStub } from '../helpers/fetchStub';
import { flushPendingOps, _resetStuckNotice } from '../../src/api/sync';
import { ATTEMPTS_CAP } from '../../src/api/syncPolicy';
import type { ApiConfig } from '../../src/api/client';
import { idbQueueOp, idbGetPendingOps } from '../../src/idb/pendingOps';
import type { PendingOp } from '../../src/api/pendingOps';
import { closeDb } from '../../src/idb/db';
import { consumeUpgradeRequired } from '../../src/api/client';
import { idbGetRetainedOps } from '../../src/idb/retainedOps';

const config: ApiConfig = { apiBase: 'http://localhost:8787', authToken: 'tok' };
const AT = '2026-06-17T10:00:00.000Z';

beforeEach(async () => {
  closeDb();
  await resetIdb();
  _resetStuckNotice();
});

afterEach(() => {
  closeDb();
});

// ─── flushPendingOps: basic outcomes ─────────────────────────────────────────

describe('flushPendingOps — basic outcomes', () => {
  test('ok: deletes op and increments flushed', async () => {
    const stub = installFetchStub();
    await idbQueueOp({ op: 'task.update', taskId: 't_abc001', body: { title: 'Fixed' } });
    stub.respondWith({ method: 'PATCH', path: '/api/tasks' }, {
      type: 'json', status: 200, body: makeTask({ id: 't_abc001', title: 'Fixed' }),
    });
    const summary = await flushPendingOps(config);
    stub.restore();

    expect(summary.flushed).toBe(1);
    expect(summary.rejected).toHaveLength(0);
    expect(summary.halted).toBe(false);
    expect(await idbGetPendingOps()).toHaveLength(0);
  });

  test('400: deletes op and reports rejection message', async () => {
    const stub = installFetchStub();
    await idbQueueOp({ op: 'task.update', taskId: 't_abc001', body: { title: 'Bad' } });
    stub.respondWith({ method: 'PATCH', path: '/api/tasks' }, {
      type: 'json', status: 400, body: { error: 'Invalid title' },
    });
    const summary = await flushPendingOps(config);
    stub.restore();

    expect(summary.rejected).toContain('Invalid title');
    expect(summary.flushed).toBe(0);
    expect(summary.halted).toBe(false);
    expect(await idbGetPendingOps()).toHaveLength(0);
  });

  test('409: treated as durable failure', async () => {
    const stub = installFetchStub();
    await idbQueueOp({ op: 'task.complete', taskId: 't_abc001' });
    stub.respondWith({ method: 'POST', path: '/complete' }, {
      type: 'json', status: 409, body: { error: 'invalid_transition' },
    });
    const summary = await flushPendingOps(config);
    stub.restore();

    expect(summary.rejected).toContain('invalid_transition');
    expect(await idbGetPendingOps()).toHaveLength(0);
  });

  test('network error: bumps attempts and halts flush', async () => {
    const stub = installFetchStub();
    await idbQueueOp({ op: 'task.update', taskId: 't_abc001', body: { title: 'A' } });
    await idbQueueOp({ op: 'task.update', taskId: 't_abc002', body: { title: 'B' } });
    stub.networkError({ path: 't_abc001' });
    const summary = await flushPendingOps(config);
    stub.restore();

    expect(summary.halted).toBe(true);
    expect(summary.flushed).toBe(0);
    expect(summary.rejected).toHaveLength(0);

    const ops = await idbGetPendingOps();
    expect(ops).toHaveLength(2);
    expect(ops[0]!.attempts).toBe(1);  // failed op: bumped
    expect(ops[1]!.attempts).toBe(0);  // later op: untouched
  });

  test('500: treated as transient — halts flush', async () => {
    const stub = installFetchStub();
    await idbQueueOp({ op: 'task.delete', taskId: 't_abc001' });
    stub.respondWith({ method: 'DELETE', path: '/api/tasks' }, {
      type: 'json', status: 500, body: { error: 'Internal Server Error' },
    });
    const summary = await flushPendingOps(config);
    stub.restore();

    expect(summary.halted).toBe(true);
    expect(summary.rejected).toHaveLength(0);
    const ops = await idbGetPendingOps();
    expect(ops).toHaveLength(1);
    expect(ops[0]!.attempts).toBe(1);
  });

  test('ordering: ok then transient stops at transient, first op consumed', async () => {
    const stub = installFetchStub();
    await idbQueueOp({ op: 'task.delete', taskId: 't_first01' });
    await idbQueueOp({ op: 'task.delete', taskId: 't_secnd01' });
    stub.respondWith({ method: 'DELETE', path: 't_first01' }, {
      type: 'json', status: 200, body: { ok: true },
    });
    stub.networkError({ path: 't_secnd01' });

    const summary = await flushPendingOps(config);
    stub.restore();

    expect(summary.flushed).toBe(1);
    expect(summary.halted).toBe(true);
    const ops = await idbGetPendingOps();
    expect(ops).toHaveLength(1);
    expect(ops[0]!.op).toBe('task.delete');
    expect((ops[0] as Extract<PendingOp, { op: 'task.delete' }>).taskId).toBe('t_secnd01');
  });
});

// ─── flushPendingOps: task.create reconciliation ─────────────────────────────

describe('flushPendingOps — task.create reconciliation', () => {
  test('success: temp id rebound in dependent ops before they are sent', async () => {
    const serverTask = makeTask({ id: 't_srv0001', title: 'New' });
    await idbQueueOp({ op: 'task.create', localId: 't_local01', body: { title: 'New' } });
    await idbQueueOp({ op: 'task.update', taskId: 't_local01', body: { title: 'Updated' } });
    await idbQueueOp({ op: 'link.create', body: { from_task_id: 't_local01', to_task_id: 't_other01', link_type: 'blocks' } });

    const stub = installFetchStub();
    stub.respondWith({ method: 'POST', path: '/api/tasks' }, {
      type: 'json', status: 200, body: serverTask,
    });
    // Dependent ops are sent with the server ID in the same flush cycle
    stub.respondWith({ method: 'PATCH', path: '/api/tasks' }, {
      type: 'json', status: 200, body: { ...serverTask, title: 'Updated' },
    });
    stub.respondWith({ method: 'POST', path: '/api/tasks/links' }, {
      type: 'json', status: 200, body: { ok: true },
    });
    const summary = await flushPendingOps(config);
    stub.restore();

    expect(summary.flushed).toBe(3);
    expect(summary.rejected).toHaveLength(0);
    expect(await idbGetPendingOps()).toHaveLength(0);

    // Verify the dependent ops were sent using the server ID, not the temp ID
    const patchCall = stub.calls.find(c => c.method === 'PATCH');
    const linkCall = stub.calls.find(c => c.method === 'POST' && (c.path as string).includes('/links'));
    expect(patchCall?.path).toContain('t_srv0001');
    expect((linkCall?.body as Record<string, unknown>)?.from_task_id).toBe('t_srv0001');
  });

  test('400: dependent ops leave the queue (retained, not sent)', async () => {
    await idbQueueOp({ op: 'task.create', localId: 't_local01', body: { title: 'Temp' } });
    await idbQueueOp({ op: 'task.update', taskId: 't_local01', body: { title: 'Updated' } });
    await idbQueueOp({ op: 'link.create', body: { from_task_id: 't_local01', to_task_id: 't_other01', link_type: 'blocks' } });

    const stub = installFetchStub();
    stub.respondWith({ method: 'POST', path: '/api/tasks' }, {
      type: 'json', status: 400, body: { error: 'Validation failed' },
    });
    const summary = await flushPendingOps(config);
    stub.restore();

    expect(summary.rejected).toHaveLength(1);
    expect(summary.rejected[0]).toContain('Validation failed');
    expect(await idbGetPendingOps()).toHaveLength(0);
  });

  test('400: rejected once even when dependent ops are present', async () => {
    await idbQueueOp({ op: 'task.create', localId: 't_local01', body: { title: 'X' } });
    await idbQueueOp({ op: 'task.update', taskId: 't_local01', body: { title: 'Y' } });
    await idbQueueOp({ op: 'task.complete', taskId: 't_local01' });

    const stub = installFetchStub();
    stub.respondWith({ method: 'POST', path: '/api/tasks' }, {
      type: 'json', status: 409, body: { error: 'Conflict' },
    });
    const summary = await flushPendingOps(config);
    stub.restore();

    // Only one rejection message (from the create op), not from the dropped dependents
    expect(summary.rejected).toHaveLength(1);
    expect(await idbGetPendingOps()).toHaveLength(0);
  });

  test('400 with details: message includes detail', async () => {
    await idbQueueOp({ op: 'task.update', taskId: 't_abc001', body: { title: '' } });

    const stub = installFetchStub();
    stub.respondWith({ method: 'PATCH', path: '/api/tasks' }, {
      type: 'json', status: 400,
      body: { error: 'Validation failed', details: [{ message: 'title too short', path: [] }] },
    });
    const summary = await flushPendingOps(config);
    stub.restore();

    expect(summary.rejected[0]).toContain('Validation failed');
    expect(summary.rejected[0]).toContain('title too short');
  });
});

// ─── flushPendingOps: attempts cap ───────────────────────────────────────────

describe('flushPendingOps — attempts cap', () => {
  test('surfaces stuck notice once when cap is reached, not again on next flush', async () => {
    // Plant an op already at attempts = ATTEMPTS_CAP - 1
    const db = await import('../../src/idb/db');
    const idb = await db.getDB();
    await new Promise<void>((resolve, reject) => {
      const tx = idb.transaction('pending_ops', 'readwrite');
      tx.objectStore('pending_ops').put({
        op: 'task.update',
        taskId: 't_abc001',
        body: { title: 'Stuck' },
        created_at: AT,
        attempts: ATTEMPTS_CAP - 1,
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    const stub = installFetchStub();
    stub.networkError();
    const r1 = await flushPendingOps(config);
    expect(r1.rejected).toHaveLength(1);
    expect(r1.rejected[0]).toContain('aren\'t syncing');

    // Second flush at cap: no second notice
    stub.networkError();
    const r2 = await flushPendingOps(config);
    stub.restore();
    expect(r2.rejected).toHaveLength(0);
  });
});

describe('flushPendingOps — retained intent', () => {
  test('a durably refused op is retained with its status and message, not lost', async () => {
    await idbQueueOp({ op: 'task.update', taskId: 't_abc001', body: { title: 'Mine' } });
    const stub = installFetchStub();
    stub.respondWith({ method: 'PATCH', path: '/api/tasks' }, { type: 'json', status: 409, body: { error: 'stale_revision' } });
    await flushPendingOps(config);
    stub.restore();
    expect(await idbGetPendingOps()).toHaveLength(0);
    const retained = await idbGetRetainedOps();
    expect(retained).toHaveLength(1);
    expect(retained[0]).toMatchObject({ reason: { kind: 'rejected', status: 409, message: 'stale_revision' }, op: { op: 'task.update', taskId: 't_abc001', body: { title: 'Mine' } } });
  });

  test('a refused create retains its dependents, in order, as dependency failures', async () => {
    await idbQueueOp({ op: 'task.create', localId: 't_local01', body: { title: 'X' } });
    await idbQueueOp({ op: 'task.update', taskId: 't_local01', body: { title: 'Y' } });
    await idbQueueOp({ op: 'task.complete', taskId: 't_local01' });
    const stub = installFetchStub();
    stub.respondWith({ method: 'POST', path: '/api/tasks' }, { type: 'json', status: 400, body: { error: 'Invalid' } });
    await flushPendingOps(config);
    stub.restore();
    const retained = await idbGetRetainedOps();
    expect(retained.map(r => [r.op.op, r.reason.kind])).toEqual([['task.create', 'rejected'], ['task.update', 'dependency'], ['task.complete', 'dependency']]);
  });

  test('transient failures are not retained', async () => {
    await idbQueueOp({ op: 'task.complete', taskId: 't_abc001' });
    const stub = installFetchStub();
    stub.respondWith({ method: 'POST', path: '/api/tasks/t_abc001/complete' }, { type: 'json', status: 503, body: { error: 'down' } });
    await flushPendingOps(config);
    stub.restore();
    expect(await idbGetRetainedOps()).toHaveLength(0);
    expect(await idbGetPendingOps()).toHaveLength(1);
  });
});

describe('flushPendingOps — single flight', () => {
  test('overlapping flushes send each queued op once and share one summary', async () => {
    await idbQueueOp({ op: 'task.create', localId: 't_local01', body: { title: 'Once' } });
    const stub = installFetchStub();
    stub.respondWith({ method: 'POST', path: '/api/tasks' }, { type: 'json', status: 201, body: makeTask({ id: 't_srv0001', title: 'Once' }) });
    const [a, b] = await Promise.all([flushPendingOps(config), flushPendingOps(config)]);
    stub.restore();
    expect(a).toBe(b);
    expect(stub.calls.filter(c => c.method === 'POST' && c.path.endsWith('/api/tasks'))).toHaveLength(1);
    expect(a.flushed).toBe(1);
    // A later flush starts a fresh run.
    expect(await flushPendingOps(config)).not.toBe(a);
  });
});

describe('flushPendingOps — upgrade required', () => {
  test('a 426 keeps the op queued, halts the flush and is not retained as a rejection', async () => {
    await idbQueueOp({ op: 'task.update', taskId: 't_abc001', body: { title: 'Mine' } });
    await idbQueueOp({ op: 'task.complete', taskId: 't_abc002' });
    const stub = installFetchStub();
    stub.respondWith({ method: 'PATCH', path: '/api/tasks' }, { type: 'json', status: 426, body: { error: 'upgrade_required' } });
    const summary = await flushPendingOps(config);
    stub.restore();
    expect(summary).toMatchObject({ flushed: 0, halted: true, rejected: [] });
    expect(await idbGetPendingOps()).toHaveLength(2);
    expect(await idbGetRetainedOps()).toHaveLength(0);
    expect(consumeUpgradeRequired()).toBe(true);
    expect(consumeUpgradeRequired()).toBe(false);
  });
});
