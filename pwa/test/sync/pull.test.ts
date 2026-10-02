import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { resetIdb } from '../helpers/idb';
import { closeDb } from '../../src/idb/db';
import { idbReadCanonical, idbReplaceCanonical } from '../../src/idb/canonical';
import { pullWorkspace } from '../../src/sync/pull';
import { canonicalFromSnapshot } from '../../src/sync/canonical';
import { installFetchStub, type FetchStub } from '../helpers/fetchStub';
import { config, page, projectImage, snapshot, taskImage } from '../helpers/syncFixtures';

let stub: FetchStub;
beforeEach(async () => { closeDb(); await resetIdb(); stub = installFetchStub(); });
afterEach(() => stub.restore());
const delta = (body: unknown, status = 200) => stub.respondWith({ method: 'POST', path: '/api/v2/sync/delta' }, { type: 'json', status, body });
const snap = (body: unknown) => stub.respondWith({ method: 'GET', path: '/api/v2/sync/snapshot' }, { type: 'json', status: 200, body });
const seed = () => idbReplaceCanonical(canonicalFromSnapshot(snapshot({ epoch: 1, sequence: 10 }, [taskImage('t_first1', 1), projectImage('p_first1', 1)])));
const resetBody = { contractVersion: 2, error: { code: 'sync_reset_required', path: [], message: 'reset', retryable: false, recoveryHint: 'bootstrap',
  syncReset: { reason: 'epoch_changed', currentCursor: { epoch: 2, sequence: 5 }, retentionFloor: 0 } } };

describe('pullWorkspace', () => {
  it('bootstraps from a snapshot when nothing is stored', async () => {
    snap(snapshot({ epoch: 1, sequence: 10 }, [taskImage('t_first1', 1)]));
    const outcome = await pullWorkspace(config);
    expect(outcome).toMatchObject({ kind: 'bootstrapped', reason: 'first_pull' });
    expect((await idbReadCanonical())?.cursor).toEqual({ epoch: 1, sequence: 10 });
    expect(stub.calls.map(call => call.path)).toEqual([expect.stringContaining('/api/v2/sync/snapshot')]);
  });

  it('stages every page with a fixed watermark and commits once', async () => {
    await seed();
    const first = page(10, 11, 12, true, [[11, taskImage('t_first1', 2, { title: 'Renamed' })]]);
    const last = page(11, 12, 12, false, [[12, taskImage('t_new001', 1)]]);
    delta(first.raw); delta(last.raw);
    const outcome = await pullWorkspace(config);
    expect(outcome.kind).toBe('updated');
    expect(stub.calls.map(call => call.body)).toEqual([
      { cursor: { epoch: 1, sequence: 10 }, limit: 500 },
      { cursor: { epoch: 1, sequence: 11 }, watermark: { epoch: 1, sequence: 12 }, limit: 500 },
    ]);
    const stored = await idbReadCanonical();
    expect(stored?.cursor.sequence).toBe(12);
    expect(stored?.entities.get('task:t_first1')).toMatchObject({ revision: 2 });
    expect(stored?.entities.has('task:t_new001')).toBe(true);
  });

  it('commits nothing when a later page fails, so a half-pull is never visible', async () => {
    await seed();
    delta(page(10, 11, 12, true, [[11, taskImage('t_first1', 2)]]).raw);
    stub.networkError({ method: 'POST', path: '/api/v2/sync/delta' });
    const outcome = await pullWorkspace(config);
    expect(outcome).toEqual({ kind: 'failed', result: { kind: 'network' } });
    const stored = await idbReadCanonical();
    expect(stored?.cursor.sequence).toBe(10);
    expect(stored?.entities.get('task:t_first1')?.revision).toBe(1);
  });

  it('reports unchanged when the server has nothing new', async () => {
    await seed();
    delta(page(10, 10, 10, false, []).raw);
    expect((await pullWorkspace(config)).kind).toBe('unchanged');
  });

  it('falls back to one bootstrap on a sync reset, replacing the old epoch entirely', async () => {
    await seed();
    delta(resetBody, 409);
    snap(snapshot({ epoch: 2, sequence: 5 }, [taskImage('t_other1', 1)]));
    const outcome = await pullWorkspace(config);
    expect(outcome).toMatchObject({ kind: 'bootstrapped', reason: 'sync_reset' });
    const stored = await idbReadCanonical();
    expect(stored?.cursor.epoch).toBe(2);
    expect([...stored!.entities.keys()]).toEqual(['task:t_other1']);
  });

  it('does not treat other 409s or auth failures as a reset', async () => {
    await seed();
    delta({ contractVersion: 2, error: { code: 'other', path: [], message: 'no', retryable: false, recoveryHint: 'x' } }, 409);
    expect((await pullWorkspace(config)).kind).toBe('failed');
    delta({ error: 'unauthorized' }, 401);
    const auth = await pullWorkspace(config);
    expect(auth).toMatchObject({ kind: 'failed', result: { kind: 'http', status: 401 } });
    expect((await idbReadCanonical())?.cursor.sequence).toBe(10);
  });

  it('re-bootstraps instead of committing an inconsistent pull', async () => {
    await seed();
    delta(page(10, 11, 11, false, [[11, taskImage('t_first1', 1)]]).raw); // revision regression
    snap(snapshot({ epoch: 1, sequence: 11 }, [taskImage('t_first1', 5)]));
    const outcome = await pullWorkspace(config);
    expect(outcome).toMatchObject({ kind: 'bootstrapped', reason: 'inconsistent' });
    expect((await idbReadCanonical())?.entities.get('task:t_first1')?.revision).toBe(5);
  });

  it('shares one pull between concurrent callers', async () => {
    snap(snapshot({ epoch: 1, sequence: 10 }, [taskImage('t_first1', 1)]));
    const [a, b] = await Promise.all([pullWorkspace(config), pullWorkspace(config)]);
    expect(a).toBe(b);
    expect(stub.calls).toHaveLength(1);
  });

  it('leaves storage empty when the first bootstrap fails', async () => {
    stub.networkError({ method: 'GET', path: '/api/v2/sync/snapshot' });
    expect((await pullWorkspace(config)).kind).toBe('failed');
    expect(await idbReadCanonical()).toBeNull();
  });
});
