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
    expect(ops[0]).toMatchObject({ op: 'command', base: null, intent: { kind: 'task.create', title: 'Buy milk', taskType: 'action' } });
    expect((ops[0] as { commandId: string }).commandId).toMatch(/^c_/);
    expect(lastData(actions)?.tasks.map(t => t.title)).toEqual(['Buy milk']);
    expect(syncs).toBe(1);
    expect(stub.calls).toHaveLength(0);
  });

  test('updateTaskAction queues only the patch and the view reflects it', async () => {
    const stub = await seed([taskImage('t_abc001', 1, { title: 'Old' })]);
    const { actions, dispatch } = makeDispatch();
    await updateTaskAction('t_abc001', { title: 'New' as NonEmptyString<200> }, config, dispatch);
    stub.restore();
    expect(await idbGetPendingOps()).toMatchObject([{ op: 'command', base: 1, intent: { kind: 'task.content', id: 't_abc001', title: 'New' } }]);
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
    expect((await idbGetPendingOps()).map(o => o.op === 'command' ? o.intent.kind : o.op)).toEqual(['task.complete', 'task.complete']);
    const ops = await idbGetPendingOps();
    expect(ops.map(o => o.op === 'command' && o.intent.kind === 'task.complete' ? o.intent.successorId : 'x').map(id => id === null ? 'none' : 'minted')).toEqual(['none', 'minted']);
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
    expect(await idbGetPendingOps()).toMatchObject([{ op: 'command', base: 1, intent: { kind: 'task.delete', id: 't_aaaaa1' } }]);
  });

  test('link actions queue link ops and the view follows', async () => {
    const stub = await seed([taskImage('t_aaaaa1', 1), taskImage('t_bbbbb1', 1)]);
    const { actions, dispatch } = makeDispatch();
    await createLinkAction('t_aaaaa1', 't_bbbbb1', 'blocks', config, dispatch);
    expect(lastData(actions)?.links).toHaveLength(1);
    await deleteLinkAction('t_aaaaa1', 't_bbbbb1', 'blocks', config, dispatch);
    stub.restore();
    expect(lastData(actions)?.links).toEqual([]);
    expect((await idbGetPendingOps()).map(o => o.op === 'command' ? [o.intent.kind, o.base] : o.op)).toEqual([['link.add', null], ['link.remove', 1]]);
  });

  test('commands on an offline-created task replay in queue order against its temp id', async () => {
    const stub = installFetchStub();
    const { actions, dispatch } = makeDispatch();
    await createTaskAction('Draft' as NonEmptyString<200>, config, dispatch);
    const id = lastData(actions)!.tasks[0]!.id;
    await updateTaskAction(id, { notes: 'details' as BoundedString<10000> }, config, dispatch);
    await completeTaskAction(id, config, dispatch);
    stub.restore();
    expect((await idbGetPendingOps()).map(o => o.op === 'command' ? [o.intent.kind, o.base] : o.op)).toEqual([['task.create', null], ['task.content', 1], ['task.complete', 2]]);
    expect(lastData(actions)?.tasks).toMatchObject([{ id, title: 'Draft', notes: 'details', status: 'done' }]);
    expect(stub.calls).toHaveLength(0);
  });

  test('a multi-field edit becomes one command per family, chained one revision apart', async () => {
    const stub = await seed([taskImage('t_abc001', 4, { title: 'Old' })]);
    const { dispatch } = makeDispatch();
    await updateTaskAction('t_abc001', { title: 'New' as NonEmptyString<200>, task_type: 'plan' }, config, dispatch);
    stub.restore();
    expect((await idbGetPendingOps()).map(o => o.op === 'command' ? [o.intent.kind, o.base] : o.op)).toEqual([['task.content', 4], ['task.type', 5]]);
  });

  test('two edits to one task chain their guards through the queue', async () => {
    const stub = await seed([taskImage('t_abc001', 4)]);
    const { dispatch } = makeDispatch();
    await updateTaskAction('t_abc001', { title: 'One' as NonEmptyString<200> }, config, dispatch);
    await updateTaskAction('t_abc001', { title: 'Two' as NonEmptyString<200> }, config, dispatch);
    stub.restore();
    expect((await idbGetPendingOps()).map(o => o.op === 'command' ? o.base : null)).toEqual([4, 5]);
  });

  test('saving an unchanged edit queues nothing and does not ask for a sync', async () => {
    const stub = await seed([taskImage('t_abc001', 4, { title: 'Same' })]);
    let syncs = 0;
    registerSyncCallback(() => { syncs++; });
    const { dispatch } = makeDispatch();
    await updateTaskAction('t_abc001', { title: 'Same' as NonEmptyString<200> }, config, dispatch);
    stub.restore();
    expect(await idbGetPendingOps()).toHaveLength(0);
    expect(syncs).toBe(0);
  });

  test('related links are queued in ascending order and removed by whichever order is stored', async () => {
    const stored = { entity: 'link', key: JSON.stringify(['t_zzzzz1', 't_aaaaa1', 'related']), revision: 2, deletedAt: null, row: { from_task_id: 't_zzzzz1', to_task_id: 't_aaaaa1', link_type: 'related' } };
    const stub = await seed([taskImage('t_aaaaa1', 1), taskImage('t_zzzzz1', 1), stored]);
    const { dispatch } = makeDispatch();
    await deleteLinkAction('t_aaaaa1', 't_zzzzz1', 'related', config, dispatch);
    await createLinkAction('t_zzzzz1', 't_aaaaa1', 'blocks', config, dispatch);
    await createLinkAction('t_zzzzz1', 't_aaaaa1', 'related', config, dispatch);
    stub.restore();
    const intents = (await idbGetPendingOps()).map(o => o.op === 'command' ? o.intent : null);
    expect(intents).toMatchObject([
      { kind: 'link.remove', from: 't_zzzzz1', to: 't_aaaaa1', linkType: 'related' },
      { kind: 'link.add', from: 't_zzzzz1', to: 't_aaaaa1', linkType: 'blocks' },
      { kind: 'link.add', from: 't_aaaaa1', to: 't_zzzzz1', linkType: 'related' },
    ]);
  });
});
