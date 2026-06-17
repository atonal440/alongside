import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { resetIdb } from '../helpers/idb';
import { makeTask } from '../helpers/fixtures';
import { installFetchStub } from '../helpers/fetchStub';
import { flushPendingOps, syncFromServer, _resetStuckNotice } from '../../src/api/sync';
import { ATTEMPTS_CAP } from '../../src/api/syncPolicy';
import type { ApiConfig } from '../../src/api/client';
import { idbQueueOp, idbGetPendingOps } from '../../src/idb/pendingOps';
import type { PendingOp } from '../../src/api/pendingOps';
import { idbGetAllTasks, idbPutTask } from '../../src/idb/tasks';
import { closeDb } from '../../src/idb/db';

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

  test('400: dependent ops dropped and temp task deleted from IDB', async () => {
    await idbPutTask(makeTask({ id: 't_local01', title: 'Temp' }));
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
    // Temp task removed from IDB
    const tasks = await idbGetAllTasks();
    expect(tasks.find(t => t.id === 't_local01')).toBeUndefined();
  });

  test('400: rejected once even when dependent ops are present', async () => {
    await idbPutTask(makeTask({ id: 't_local01' }));
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

// ─── syncFromServer: survivor protection ─────────────────────────────────────

describe('syncFromServer — survivor protection', () => {
  test('local task with pending task.create survives', async () => {
    await idbPutTask(makeTask({ id: 't_local01', title: 'Offline created' }));
    await idbQueueOp({ op: 'task.create', localId: 't_local01', body: { title: 'Offline created' } });

    const remoteTask = makeTask({ id: 't_remote1' });
    const stub = installFetchStub();
    stub.respondWith({ method: 'GET', path: '/api/tasks/sync' }, {
      type: 'json', status: 200, body: [remoteTask],
    });
    stub.respondWith({ method: 'GET', path: '/api/projects/sync' }, {
      type: 'json', status: 200, body: [],
    });
    stub.respondWith({ method: 'GET', path: '/api/tasks/links' }, {
      type: 'json', status: 200, body: [],
    });
    const result = await syncFromServer(config);
    stub.restore();

    expect(result.online).toBe(true);
    const tasks = await idbGetAllTasks();
    const ids = tasks.map(t => t.id);
    expect(ids).toContain('t_local01');
    expect(ids).toContain('t_remote1');
  });

  test('local task without pending task.create is deleted', async () => {
    await idbPutTask(makeTask({ id: 't_stale01', title: 'Stale' }));

    const remoteTask = makeTask({ id: 't_remote1' });
    const stub = installFetchStub();
    stub.respondWith({ method: 'GET', path: '/api/tasks/sync' }, {
      type: 'json', status: 200, body: [remoteTask],
    });
    stub.respondWith({ method: 'GET', path: '/api/projects/sync' }, {
      type: 'json', status: 200, body: [],
    });
    stub.respondWith({ method: 'GET', path: '/api/tasks/links' }, {
      type: 'json', status: 200, body: [],
    });
    const result = await syncFromServer(config);
    stub.restore();

    expect(result.online).toBe(true);
    const tasks = await idbGetAllTasks();
    expect(tasks.find(t => t.id === 't_stale01')).toBeUndefined();
  });

  test('two offline tasks with identical titles both survive (title-heuristic regression)', async () => {
    const localA = makeTask({ id: 't_local0a', title: 'Same title' });
    const localB = makeTask({ id: 't_local0b', title: 'Same title' });
    await idbPutTask(localA);
    await idbPutTask(localB);
    await idbQueueOp({ op: 'task.create', localId: 't_local0a', body: { title: 'Same title' } });
    await idbQueueOp({ op: 'task.create', localId: 't_local0b', body: { title: 'Same title' } });

    const stub = installFetchStub();
    stub.respondWith({ method: 'GET', path: '/api/tasks/sync' }, {
      type: 'json', status: 200, body: [],
    });
    stub.respondWith({ method: 'GET', path: '/api/projects/sync' }, {
      type: 'json', status: 200, body: [],
    });
    stub.respondWith({ method: 'GET', path: '/api/tasks/links' }, {
      type: 'json', status: 200, body: [],
    });
    const result = await syncFromServer(config);
    stub.restore();

    expect(result.online).toBe(true);
    const tasks = await idbGetAllTasks();
    const ids = tasks.map(t => t.id);
    expect(ids).toContain('t_local0a');
    expect(ids).toContain('t_local0b');
  });

  test('syncTasks non-ok result returns online: false', async () => {
    const stub = installFetchStub();
    stub.networkError({ path: '/api/tasks/sync' });
    const result = await syncFromServer(config);
    stub.restore();

    expect(result.online).toBe(false);
  });
});
