import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { resetIdb } from '../helpers/idb';
import { closeDb } from '../../src/idb/db';
import { resetPullCache } from '../../src/sync/pull';
import { refreshFromCanonical } from '../../src/sync/refresh';
import { loadView } from '../../src/sync/view';
import { idbQueueOp } from '../../src/idb/pendingOps';
import { installFetchStub, type FetchStub } from '../helpers/fetchStub';
import { config, projectImage, snapshot, taskImage } from '../helpers/syncFixtures';

let stub: FetchStub;
beforeEach(async () => { closeDb(); await resetIdb(); resetPullCache(); stub = installFetchStub(); });
afterEach(() => stub.restore());
const snap = (entities: unknown[]) => stub.respondWith({ method: 'GET', path: '/api/v2/sync/snapshot' }, { type: 'json', status: 200, body: snapshot({ epoch: 1, sequence: 3 }, entities) });
const link = { entity: 'link', key: JSON.stringify(['t_aaaaa1', 't_bbbbb1', 'blocks']), revision: 1, deletedAt: null, row: { from_task_id: 't_aaaaa1', to_task_id: 't_bbbbb1', link_type: 'blocks' } };

describe('refreshFromCanonical', () => {
  it('returns canonical tasks, projects and links', async () => {
    snap([taskImage('t_aaaaa1', 1), taskImage('t_bbbbb1', 1), projectImage('p_first1', 1), link]);
    const result = await refreshFromCanonical(config);
    expect(result.online).toBe(true);
    expect(result.tasks?.map(t => t.id).sort()).toEqual(['t_aaaaa1', 't_bbbbb1']);
    expect(result.projects).toHaveLength(1);
    expect(result.links).toHaveLength(1);
  });

  it('keeps offline-created tasks (and their queued edits) because pending ops are replayed', async () => {
    await idbQueueOp({ op: 'task.create', localId: 't_local0a', body: { title: 'Same title' } });
    await idbQueueOp({ op: 'task.create', localId: 't_local0b', body: { title: 'Same title' } });
    await idbQueueOp({ op: 'task.update', taskId: 't_local0a', body: { notes: 'edited' } });
    snap([taskImage('t_remote1', 1)]);
    const result = await refreshFromCanonical(config);
    expect(result.tasks?.map(t => t.id).sort()).toEqual(['t_local0a', 't_local0b', 't_remote1']);
    expect(result.tasks?.find(t => t.id === 't_local0a')?.notes).toBe('edited');
  });

  it('offline reports offline', async () => {
    stub.networkError({ method: 'GET', path: '/api/v2/sync/snapshot' });
    expect(await refreshFromCanonical(config)).toEqual({ online: false });
  });
});

describe('loadView', () => {
  it('is just the queue before the first pull', async () => {
    await idbQueueOp({ op: 'task.create', localId: 't_local01', body: { title: 'Offline first' } });
    const view = await loadView(config.apiBase);
    expect(view.tasks.map(t => t.title)).toEqual(['Offline first']);
  });

  it('reads the stored canonical workspace plus the queue without the network', async () => {
    snap([taskImage('t_aaaaa1', 1, { title: 'Server' })]);
    await refreshFromCanonical(config);
    await idbQueueOp({ op: 'task.update', taskId: 't_aaaaa1', body: { title: 'Mine' } });
    resetPullCache();
    const view = await loadView(config.apiBase);
    expect(view.tasks.map(t => t.title)).toEqual(['Mine']);
    expect(stub.calls).toHaveLength(1);
  });

  it('ignores a cache written for another server', async () => {
    snap([taskImage('t_aaaaa1', 1)]);
    await refreshFromCanonical(config);
    expect((await loadView('http://other.example')).tasks).toEqual([]);
  });
});
