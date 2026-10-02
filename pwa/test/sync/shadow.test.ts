import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { resetIdb } from '../helpers/idb';
import { closeDb } from '../../src/idb/db';
import { resetPullCache } from '../../src/sync/pull';
import { compareToLegacy, shadowSync } from '../../src/sync/shadow';
import { idbQueueOp } from '../../src/idb/pendingOps';
import { installFetchStub, type FetchStub } from '../helpers/fetchStub';
import { makeTask } from '../helpers/fixtures';
import { config, snapshot, taskImage } from '../helpers/syncFixtures';

let stub: FetchStub;
beforeEach(async () => { closeDb(); await resetIdb(); resetPullCache(); stub = installFetchStub(); });
afterEach(() => stub.restore());
const snap = (entities: unknown[]) => stub.respondWith({ method: 'GET', path: '/api/v2/sync/snapshot' }, { type: 'json', status: 200, body: snapshot({ epoch: 1, sequence: 3 }, entities) });

describe('compareToLegacy', () => {
  const link = { from_task_id: 't_a', to_task_id: 't_b', link_type: 'blocks' as const };
  it('is empty when both sides agree', () => {
    const t = [makeTask({ id: 't_a' })];
    expect(compareToLegacy({ tasks: t, links: [link] }, { tasks: t, links: [link] })).toEqual([]);
  });
  it('names missing tasks, differing fields and link asymmetries', () => {
    const out = compareToLegacy(
      { tasks: [makeTask({ id: 't_a', title: 'New' }), makeTask({ id: 't_x' })], links: [link] },
      { tasks: [makeTask({ id: 't_a', title: 'Old' }), makeTask({ id: 't_y' })], links: [] });
    expect(out).toEqual(expect.arrayContaining([
      'task t_x only in canonical view', 'task t_y only in legacy state',
      'task t_a title: canonical "New" vs legacy "Old"', 'link t_a>t_b:blocks only in canonical view']));
  });
});

describe('shadowSync', () => {
  it('pulls the canonical store and reports no divergence when legacy matches, including pending ops', async () => {
    snap([taskImage('t_aaaaa1', 1, { title: 'Server' })]);
    await idbQueueOp({ op: 'task.update', taskId: 't_aaaaa1', body: { title: 'Edited' } });
    const result = await shadowSync(config, { tasks: [makeTask({ id: 't_aaaaa1', title: 'Edited' })], links: [] });
    expect(result.outcome.kind).toBe('bootstrapped');
    expect(result.divergences).toEqual([]);
  });

  it('reports divergence without throwing', async () => {
    snap([taskImage('t_aaaaa1', 1, { title: 'Server' })]);
    const result = await shadowSync(config, { tasks: [], links: [] });
    expect(result.divergences).toEqual(['task t_aaaaa1 only in canonical view']);
  });

  it('a failed pull is reported as failed with no divergences', async () => {
    stub.networkError({ method: 'GET', path: '/api/v2/sync/snapshot' });
    const result = await shadowSync(config, { tasks: [], links: [] });
    expect(result).toMatchObject({ outcome: { kind: 'failed' }, divergences: [] });
  });
});
