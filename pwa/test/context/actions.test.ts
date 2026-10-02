import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { resetIdb } from '../helpers/idb';
import type { BoundedString, NonEmptyString } from '@shared/parse';
import { installFetchStub } from '../helpers/fetchStub';
import {
  registerSyncCallback,
  createTaskAction,
  createLinkAction,
  deleteLinkAction,
  completeTaskAction,
  updateTaskAction,
  deleteTaskAction,
  focusTaskAction,
} from '../../src/context/actions';
import type { AppAction } from '../../src/context/reducer';
import type { ApiConfig } from '../../src/api/client';
import { idbGetPendingOps } from '../../src/idb/pendingOps';
import { closeDb } from '../../src/idb/db';
import { resetPullCache, pullWorkspace } from '../../src/sync/pull';
import { config as syncConfig, snapshot, taskImage } from '../helpers/syncFixtures';

const config: ApiConfig = syncConfig;

function makeDispatch() {
  const actions: AppAction[] = [];
  return { actions, dispatch: (a: AppAction) => { actions.push(a); } };
}
const lastData = (actions: AppAction[]) => [...actions].reverse().find((a): a is Extract<AppAction, { type: 'SET_DATA' }> => a.type === 'SET_DATA');

// Seed a canonical workspace through the real pull path, then forbid further network use: actions
// must never talk to the server themselves.
async function seed(entities: unknown[]) {
  const stub = installFetchStub();
  stub.respondWith({ method: 'GET', path: '/api/v2/sync/snapshot' }, { type: 'json', status: 200, body: snapshot({ epoch: 1, sequence: 1 }, entities) });
  await pullWorkspace(config, { fresh: true });
  stub.restore();
  return installFetchStub();
}

beforeEach(async () => { closeDb(); await resetIdb(); resetPullCache(); registerSyncCallback(() => {}); });
afterEach(() => { closeDb(); vi.restoreAllMocks(); });

describe('actions queue commands and show canonical + queue', () => {
  test('createTaskAction queues a create, shows it immediately and requests a sync, with no network call', async () => {
    const stub = installFetchStub();
    let syncs = 0;
    registerSyncCallback(() => { syncs++; });
    const { actions, dispatch } = makeDispatch();
    await createTaskAction('Buy milk' as NonEmptyString<200>, config, dispatch);
    stub.restore();
    const ops = await idbGetPendingOps();
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ op: 'task.create', body: { title: 'Buy milk' } });
    expect(lastData(actions)?.tasks.map(t => t.title)).toEqual(['Buy milk']);
    expect(syncs).toBe(1);
    expect(stub.calls).toHaveLength(0);
  });

  test('updateTaskAction queues only the patch and the view reflects it', async () => {
    const stub = await seed([taskImage('t_abc001', 1, { title: 'Old' })]);
    const { actions, dispatch } = makeDispatch();
    await updateTaskAction('t_abc001', { title: 'New' as NonEmptyString<200> }, config, dispatch);
    stub.restore();
    expect(await idbGetPendingOps()).toMatchObject([{ op: 'task.update', taskId: 't_abc001', body: { title: 'New' } }]);
    expect(lastData(actions)?.tasks.find(t => t.id === 't_abc001')?.title).toBe('New');
    expect(stub.calls).toHaveLength(0);
  });

  test('a refused local mutation toasts and queues nothing', async () => {
    const stub = await seed([taskImage('t_abc001', 1, { status: 'done' })]);
    const { actions, dispatch } = makeDispatch();
    await focusTaskAction('t_abc001', config, dispatch);
    stub.restore();
    expect(actions.some(a => a.type === 'SET_TOAST')).toBe(true);
    expect(await idbGetPendingOps()).toHaveLength(0);
  });

  test('unknown task ids are ignored', async () => {
    const stub = await seed([]);
    const { actions, dispatch } = makeDispatch();
    await updateTaskAction('t_missing', { title: 'x' as NonEmptyString<200> }, config, dispatch);
    expect(await completeTaskAction('t_missing', config, dispatch)).toBeNull();
    stub.restore();
    expect(actions).toEqual([]);
    expect(await idbGetPendingOps()).toHaveLength(0);
  });

  test('completeTaskAction queues the completion; recurring tasks explain the next occurrence', async () => {
    const stub = await seed([taskImage('t_once01', 1), taskImage('t_rec001', 1, { due_date: '2026-10-03T12:00:00Z', due_all_day: true, recurrence: 'FREQ=DAILY' })]);
    const { actions, dispatch } = makeDispatch();
    expect(await completeTaskAction('t_once01', config, dispatch)).toBeNull();
    expect(await completeTaskAction('t_rec001', config, dispatch)).toMatch(/next occurrence/i);
    stub.restore();
    expect((await idbGetPendingOps()).map(o => o.op)).toEqual(['task.complete', 'task.complete']);
    expect(lastData(actions)?.tasks.every(t => t.status === 'done')).toBe(true);
  });

  test('completing an already-done task toasts and queues nothing', async () => {
    const stub = await seed([taskImage('t_abc001', 1, { status: 'done' })]);
    const { actions, dispatch } = makeDispatch();
    await completeTaskAction('t_abc001', config, dispatch);
    stub.restore();
    expect(actions.some(a => a.type === 'SET_TOAST')).toBe(true);
    expect(await idbGetPendingOps()).toHaveLength(0);
  });

  test('deleteTaskAction queues a delete and removes the task and its links from view', async () => {
    const link = { entity: 'link', key: JSON.stringify(['t_aaaaa1', 't_bbbbb1', 'blocks']), revision: 1, deletedAt: null, row: { from_task_id: 't_aaaaa1', to_task_id: 't_bbbbb1', link_type: 'blocks' } };
    const stub = await seed([taskImage('t_aaaaa1', 1), taskImage('t_bbbbb1', 1), link]);
    const { actions, dispatch } = makeDispatch();
    await deleteTaskAction('t_aaaaa1', config, dispatch);
    stub.restore();
    const data = lastData(actions)!;
    expect(data.tasks.map(t => t.id)).toEqual(['t_bbbbb1']);
    expect(data.links).toEqual([]);
    expect(await idbGetPendingOps()).toMatchObject([{ op: 'task.delete', taskId: 't_aaaaa1' }]);
  });

  test('link actions queue link ops and the view follows', async () => {
    const stub = await seed([taskImage('t_aaaaa1', 1), taskImage('t_bbbbb1', 1)]);
    const { actions, dispatch } = makeDispatch();
    await createLinkAction('t_aaaaa1', 't_bbbbb1', 'blocks', config, dispatch);
    expect(lastData(actions)?.links).toHaveLength(1);
    await deleteLinkAction('t_aaaaa1', 't_bbbbb1', 'blocks', config, dispatch);
    stub.restore();
    expect(lastData(actions)?.links).toEqual([]);
    expect((await idbGetPendingOps()).map(o => o.op)).toEqual(['link.create', 'link.delete']);
  });

  test('commands on an offline-created task replay in queue order against its temp id', async () => {
    const stub = installFetchStub();
    const { actions, dispatch } = makeDispatch();
    await createTaskAction('Draft' as NonEmptyString<200>, config, dispatch);
    const id = lastData(actions)!.tasks[0]!.id;
    await updateTaskAction(id, { notes: 'details' as BoundedString<10000> }, config, dispatch);
    await completeTaskAction(id, config, dispatch);
    stub.restore();
    expect((await idbGetPendingOps()).map(o => o.op)).toEqual(['task.create', 'task.update', 'task.complete']);
    expect(lastData(actions)?.tasks).toMatchObject([{ id, title: 'Draft', notes: 'details', status: 'done' }]);
    expect(stub.calls).toHaveLength(0);
  });
});
