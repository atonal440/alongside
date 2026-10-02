import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { resetIdb } from '../helpers/idb';
import { closeDb } from '../../src/idb/db';
import { resetPullCache } from '../../src/sync/pull';
import { refreshFromCanonical } from '../../src/sync/refresh';
import { idbQueueOp } from '../../src/idb/pendingOps';
import { idbGetAllTasks, idbPutTask } from '../../src/idb/tasks';
import { idbGetAllLinks } from '../../src/idb/links';
import { idbGetAllProjects } from '../../src/idb/projects';
import { installFetchStub, type FetchStub } from '../helpers/fetchStub';
import { makeTask } from '../helpers/fixtures';
import { config, projectImage, snapshot, taskImage } from '../helpers/syncFixtures';

let stub: FetchStub;
beforeEach(async () => { closeDb(); await resetIdb(); resetPullCache(); stub = installFetchStub(); });
afterEach(() => stub.restore());
const snap = (entities: unknown[]) => stub.respondWith({ method: 'GET', path: '/api/v2/sync/snapshot' }, { type: 'json', status: 200, body: snapshot({ epoch: 1, sequence: 3 }, entities) });

describe('refreshFromCanonical', () => {
  it('writes canonical tasks, projects and links to the mirror and returns them', async () => {
    snap([taskImage('t_aaaaa1', 1), taskImage('t_bbbbb1', 1), projectImage('p_first1', 1),
      { entity: 'link', key: JSON.stringify(['t_aaaaa1', 't_bbbbb1', 'blocks']), revision: 1, deletedAt: null, row: { from_task_id: 't_aaaaa1', to_task_id: 't_bbbbb1', link_type: 'blocks' } }]);
    const result = await refreshFromCanonical(config);
    expect(result.online).toBe(true);
    expect((await idbGetAllTasks()).map(t => t.id).sort()).toEqual(['t_aaaaa1', 't_bbbbb1']);
    expect(await idbGetAllProjects()).toHaveLength(1);
    expect(await idbGetAllLinks()).toHaveLength(1);
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

  it('drops local tasks the server does not have and nothing queues for (rollback)', async () => {
    await idbPutTask(makeTask({ id: 't_stale01' }));
    snap([taskImage('t_remote1', 1)]);
    await refreshFromCanonical(config);
    expect((await idbGetAllTasks()).map(t => t.id)).toEqual(['t_remote1']);
  });

  it('offline leaves the mirror untouched', async () => {
    await idbPutTask(makeTask({ id: 't_keep001' }));
    stub.networkError({ method: 'GET', path: '/api/v2/sync/snapshot' });
    const result = await refreshFromCanonical(config);
    expect(result).toEqual({ online: false });
    expect((await idbGetAllTasks()).map(t => t.id)).toEqual(['t_keep001']);
  });
});
