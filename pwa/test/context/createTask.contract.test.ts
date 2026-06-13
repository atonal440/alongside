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
  test('leaves pending-ops store empty and optimistic task in place', async () => {
    const stub = installFetchStub();
    // Server returns 200 OK but body is malformed (missing required fields)
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

    // Optimistic task must still be in IDB
    const tasks = await idbGetAllTasks();
    expect(tasks.some(t => t.title === 'Test task')).toBe(true);

    // The UPSERT_TASK for the optimistic task was dispatched
    const upserts = dispatched.filter(a => a.type === 'UPSERT_TASK');
    expect(upserts.length).toBeGreaterThanOrEqual(1);
  });
});
