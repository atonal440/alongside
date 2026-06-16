import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { createTaskAction } from '../../src/context/actions';
import { idbGetPendingOps } from '../../src/idb/pendingOps';
import { idbGetAllTasks } from '../../src/idb/tasks';
import { installFetchStub } from '../helpers/fetchStub';
import { resetIdb } from '../helpers/idb';
import type { ApiConfig } from '../../src/api/client';
import type { AppAction } from '../../src/context/reducer';

const config: ApiConfig = { apiBase: 'http://localhost:8787', authToken: 'tok' };

beforeEach(() => resetIdb());
afterEach(() => { vi.restoreAllMocks(); });

describe('createTaskAction — contract violation', () => {
  test('no-id body: pending-ops empty, optimistic task stays in place', async () => {
    const stub = installFetchStub();
    // Malformed body with no id field — can't rebind
    stub.respondWith({ method: 'POST', path: '/api/tasks' }, {
      type: 'json', status: 200, body: { title: 'No ID here' },
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const dispatched: AppAction[] = [];
    await createTaskAction('Test task', config, action => { dispatched.push(action); });
    stub.restore();

    // Pending ops store must be empty — no retry was enqueued
    const ops = await idbGetPendingOps();
    expect(ops).toHaveLength(0);

    // Optimistic task must still be in IDB (with its temp id)
    const tasks = await idbGetAllTasks();
    expect(tasks.some(t => t.title === 'Test task')).toBe(true);

    // The initial UPSERT_TASK for the optimistic task was dispatched
    const upserts = dispatched.filter(a => a.type === 'UPSERT_TASK');
    expect(upserts.length).toBeGreaterThanOrEqual(1);
  });

  test('has-id body: task reidentified with server id, no pending op', async () => {
    const stub = installFetchStub();
    // Body has a valid id but fails full schema (missing required fields)
    stub.respondWith({ method: 'POST', path: '/api/tasks' }, {
      type: 'json', status: 200, body: { id: 't_server1', title: 'Test task' },
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const dispatched: AppAction[] = [];
    await createTaskAction('Test task', config, action => { dispatched.push(action); });
    stub.restore();

    // No pending op queued
    const ops = await idbGetPendingOps();
    expect(ops).toHaveLength(0);

    // Task in IDB should now carry the server id
    const tasks = await idbGetAllTasks();
    const reidentified = tasks.find(t => t.id === 't_server1');
    expect(reidentified).toBeDefined();
    expect(reidentified!.title).toBe('Test task');

    // DELETE + UPSERT dispatched for the reidentification
    const deletes = dispatched.filter(a => a.type === 'DELETE_TASK');
    const upserts = dispatched.filter(a => a.type === 'UPSERT_TASK');
    expect(deletes.length).toBeGreaterThanOrEqual(1);
    expect(upserts.length).toBeGreaterThanOrEqual(2); // initial + reidentified
  });
});
