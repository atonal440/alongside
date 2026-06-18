import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { resetIdb } from '../helpers/idb';
import { makeTask } from '../helpers/fixtures';
import { installFetchStub } from '../helpers/fetchStub';
import {
  registerSyncCallback,
  createTaskAction,
  createLinkAction,
  completeTaskAction,
  updateTaskAction,
} from '../../src/context/actions';
import type { AppAction } from '../../src/context/reducer';
import type { ApiConfig } from '../../src/api/client';
import { idbGetPendingOps } from '../../src/idb/pendingOps';
import { idbGetAllTasks, idbPutTask } from '../../src/idb/tasks';
import { closeDb } from '../../src/idb/db';

const config: ApiConfig = { apiBase: 'http://localhost:8787', authToken: 'tok' };

function makeDispatch() {
  const actions: AppAction[] = [];
  const dispatch = (a: AppAction) => { actions.push(a); };
  return { actions, dispatch };
}

beforeEach(async () => {
  closeDb();
  await resetIdb();
});

afterEach(() => {
  closeDb();
  vi.restoreAllMocks();
});

// ─── createLinkAction ─────────────────────────────────────────────────────────

describe('createLinkAction', () => {
  test('409 self-link: toast dispatched, op not queued, sync triggered', async () => {
    let syncCalled = false;
    registerSyncCallback(() => { syncCalled = true; });

    const { actions, dispatch } = makeDispatch();
    const stub = installFetchStub();
    stub.respondWith({ method: 'POST', path: '/api/tasks/links' }, {
      type: 'json', status: 409, body: { error: 'Self-links not allowed' },
    });

    await createLinkAction('t_abc001', 't_abc001', 'blocks', config, dispatch);
    stub.restore();

    // Toast was dispatched
    const toast = actions.find(a => a.type === 'SET_TOAST');
    expect(toast).toBeDefined();
    expect((toast as Extract<AppAction, { type: 'SET_TOAST' }>).message).toContain('Self-links not allowed');

    // Op was not queued
    expect(await idbGetPendingOps()).toHaveLength(0);

    // Resync was triggered
    expect(syncCalled).toBe(true);
  });

  test('offline: link is queued, no toast', async () => {
    const { actions, dispatch } = makeDispatch();
    const stub = installFetchStub();
    stub.networkError({ method: 'POST', path: '/api/tasks/links' });

    await createLinkAction('t_abc001', 't_bcd001', 'blocks', config, dispatch);
    stub.restore();

    const ops = await idbGetPendingOps();
    expect(ops).toHaveLength(1);
    expect(ops[0]!.op).toBe('link.create');
    expect(actions.find(a => a.type === 'SET_TOAST')).toBeUndefined();
  });
});

// ─── completeTaskAction ───────────────────────────────────────────────────────

describe('completeTaskAction', () => {
  test('offline: op queued, no toast from rejection', async () => {
    const task = makeTask({ id: 't_abc001' });
    await idbPutTask(task);

    const { actions, dispatch } = makeDispatch();
    const stub = installFetchStub();
    stub.networkError({ method: 'POST', path: '/complete' });

    await completeTaskAction('t_abc001', config, dispatch);
    stub.restore();

    const ops = await idbGetPendingOps();
    expect(ops).toHaveLength(1);
    expect(ops[0]!.op).toBe('task.complete');
    expect(actions.find(a => a.type === 'SET_TOAST')).toBeUndefined();
  });

  test('409 invalid_transition: toast dispatched, op not queued', async () => {
    const task = makeTask({ id: 't_abc001', status: 'done' });
    await idbPutTask(task);

    let syncCalled = false;
    registerSyncCallback(() => { syncCalled = true; });

    const { actions, dispatch } = makeDispatch();
    const stub = installFetchStub();
    stub.respondWith({ method: 'POST', path: '/complete' }, {
      type: 'json', status: 409, body: { error: 'invalid_transition' },
    });

    await completeTaskAction('t_abc001', config, dispatch);
    stub.restore();

    const toast = actions.find(a => a.type === 'SET_TOAST');
    expect(toast).toBeDefined();
    expect((toast as Extract<AppAction, { type: 'SET_TOAST' }>).message).toContain('invalid_transition');
    expect(await idbGetPendingOps()).toHaveLength(0);
    expect(syncCalled).toBe(true);
  });

  test('recurring task offline: toast message about next occurrence returned', async () => {
    const task = makeTask({ id: 't_abc001', recurrence: 'FREQ=DAILY', due_date: '2026-06-17' });
    await idbPutTask(task);

    const { dispatch } = makeDispatch();
    const stub = installFetchStub();
    stub.networkError({ method: 'POST', path: '/complete' });

    const msg = await completeTaskAction('t_abc001', config, dispatch);
    stub.restore();

    expect(msg).toContain('Next occurrence will sync');
    const ops = await idbGetPendingOps();
    expect(ops).toHaveLength(1);
    expect(ops[0]!.op).toBe('task.complete');
  });
});

// ─── createTaskAction ─────────────────────────────────────────────────────────

describe('createTaskAction', () => {
  test('400: toast dispatched, temp task eventually deleted by resync', async () => {
    let syncCalled = false;
    registerSyncCallback(() => { syncCalled = true; });

    const { actions, dispatch } = makeDispatch();
    const stub = installFetchStub();
    stub.respondWith({ method: 'POST', path: '/api/tasks' }, {
      type: 'json', status: 400, body: { error: 'Title too short' },
    });

    await createTaskAction('A', config, dispatch);
    stub.restore();

    const toast = actions.find(a => a.type === 'SET_TOAST');
    expect(toast).toBeDefined();
    expect(await idbGetPendingOps()).toHaveLength(0);
    expect(syncCalled).toBe(true);
  });

  test('offline: op queued with localId, temp task remains in IDB', async () => {
    const { dispatch } = makeDispatch();
    const stub = installFetchStub();
    stub.networkError({ method: 'POST', path: '/api/tasks' });

    await createTaskAction('New task', config, dispatch);
    stub.restore();

    const ops = await idbGetPendingOps();
    expect(ops).toHaveLength(1);
    const op = ops[0] as Extract<typeof ops[number], { op: 'task.create' }>;
    expect(op.op).toBe('task.create');
    expect(op.body.title).toBe('New task');

    const tasks = await idbGetAllTasks();
    expect(tasks.find(t => t.id === op.localId)).toBeDefined();
  });
});

// ─── pending-create guard ─────────────────────────────────────────────────────

describe('writes against pending local tasks', () => {
  async function seedOfflineCreate(): Promise<string> {
    const { dispatch } = makeDispatch();
    const stub = installFetchStub();
    stub.networkError({ method: 'POST', path: '/api/tasks' });
    await createTaskAction('Offline task', config, dispatch);
    stub.restore();
    const ops = await idbGetPendingOps();
    const createOp = ops.find(o => o.op === 'task.create') as Extract<typeof ops[number], { op: 'task.create' }>;
    return createOp.localId;
  }

  test('updateTaskAction on temp-id: queued without API call', async () => {
    const tempId = await seedOfflineCreate();

    // installFetchStub with no routes configured: any network call would throw
    const stub = installFetchStub();
    const { dispatch, actions } = makeDispatch();
    await updateTaskAction(tempId, { title: 'Revised' }, config, dispatch);
    stub.restore();

    const opsAfter = await idbGetPendingOps();
    expect(opsAfter.some(o => o.op === 'task.update')).toBe(true);
    expect(actions.find(a => a.type === 'SET_TOAST')).toBeUndefined();
  });

  test('completeTaskAction on temp-id: queued without API call', async () => {
    const tempId = await seedOfflineCreate();

    const stub = installFetchStub();
    const { dispatch, actions } = makeDispatch();
    await completeTaskAction(tempId, config, dispatch);
    stub.restore();

    const opsAfter = await idbGetPendingOps();
    expect(opsAfter.some(o => o.op === 'task.complete')).toBe(true);
    expect(actions.find(a => a.type === 'SET_TOAST')).toBeUndefined();
  });

  test('createLinkAction with temp-id endpoint: queued without API call', async () => {
    const tempId = await seedOfflineCreate();

    const stub = installFetchStub();
    const { dispatch, actions } = makeDispatch();
    await createLinkAction(tempId, 't_abc001', 'blocks', config, dispatch);
    stub.restore();

    const opsAfter = await idbGetPendingOps();
    expect(opsAfter.some(o => o.op === 'link.create')).toBe(true);
    expect(actions.find(a => a.type === 'SET_TOAST')).toBeUndefined();
  });
});

// ─── updateTaskAction ─────────────────────────────────────────────────────────

describe('updateTaskAction', () => {
  test('400: toast dispatched, op not queued', async () => {
    const task = makeTask({ id: 't_abc001' });
    await idbPutTask(task);

    let syncCalled = false;
    registerSyncCallback(() => { syncCalled = true; });
    const { actions, dispatch } = makeDispatch();

    const stub = installFetchStub();
    stub.respondWith({ method: 'PATCH', path: '/api/tasks' }, {
      type: 'json', status: 400, body: { error: 'Invalid update' },
    });

    await updateTaskAction('t_abc001', { title: '' }, config, dispatch);
    stub.restore();

    const toast = actions.find(a => a.type === 'SET_TOAST');
    expect(toast).toBeDefined();
    expect(await idbGetPendingOps()).toHaveLength(0);
    expect(syncCalled).toBe(true);
  });

  test('offline: op queued', async () => {
    const task = makeTask({ id: 't_abc001' });
    await idbPutTask(task);

    const { dispatch } = makeDispatch();
    const stub = installFetchStub();
    stub.networkError({ method: 'PATCH', path: '/api/tasks' });

    await updateTaskAction('t_abc001', { title: 'Updated' }, config, dispatch);
    stub.restore();

    const ops = await idbGetPendingOps();
    expect(ops).toHaveLength(1);
    expect(ops[0]!.op).toBe('task.update');
  });
});
