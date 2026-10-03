import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { resetIdb } from '../helpers/idb';
import { closeDb } from '../../src/idb/db';
import { consumeUpgradeRequired } from '../../src/api/client';
import { idbReadCanonical, idbReplaceCanonical } from '../../src/idb/canonical';
import { pullWorkspace, resetPullCache } from '../../src/sync/pull';
import { api } from '../../src/api/endpoints';
import { canonicalFromSnapshot } from '../../src/sync/canonical';
import { installFetchStub, type FetchStub } from '../helpers/fetchStub';
import { config, page, projectImage, snapshot, taskImage } from '../helpers/syncFixtures';

let stub: FetchStub;
beforeEach(async () => { closeDb(); await resetIdb(); resetPullCache(); stub = installFetchStub(); });
afterEach(() => { stub.restore(); vi.restoreAllMocks(); });
const delta = (body: unknown, status = 200) => stub.respondWith({ method: 'POST', path: '/api/v2/sync/delta' }, { type: 'json', status, body });
const snap = (body: unknown) => stub.respondWith({ method: 'GET', path: '/api/v2/sync/snapshot' }, { type: 'json', status: 200, body });
const SRC = config.apiBase;
const seed = () => idbReplaceCanonical(canonicalFromSnapshot(snapshot({ epoch: 1, sequence: 10 }, [taskImage('t_first1', 1), projectImage('p_first1', 1)])), SRC);
const read = () => idbReadCanonical(SRC);
const resetBody = { contractVersion: 2, error: { code: 'sync_reset_required', path: [], message: 'reset', retryable: false, recoveryHint: 'bootstrap',
  syncReset: { reason: 'epoch_changed', currentCursor: { epoch: 2, sequence: 5 }, retentionFloor: 0 } } };

describe('pullWorkspace', () => {
  it('bootstraps from a snapshot when nothing is stored', async () => {
    snap(snapshot({ epoch: 1, sequence: 10 }, [taskImage('t_first1', 1)]));
    const outcome = await pullWorkspace(config);
    expect(outcome).toMatchObject({ kind: 'bootstrapped', reason: 'first_pull' });
    expect((await read())?.cursor).toEqual({ epoch: 1, sequence: 10 });
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
    const stored = await read();
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
    const stored = await read();
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
    const stored = await read();
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
    expect((await read())?.cursor.sequence).toBe(10);
  });

  it('re-bootstraps instead of committing an inconsistent pull', async () => {
    await seed();
    delta(page(10, 11, 11, false, [[11, taskImage('t_first1', 1)]]).raw); // revision regression
    snap(snapshot({ epoch: 1, sequence: 11 }, [taskImage('t_first1', 5)]));
    const outcome = await pullWorkspace(config);
    expect(outcome).toMatchObject({ kind: 'bootstrapped', reason: 'inconsistent' });
    expect((await read())?.entities.get('task:t_first1')?.revision).toBe(5);
  });

  it('discards a cache from another server and starts from a snapshot', async () => {
    await idbReplaceCanonical(canonicalFromSnapshot(snapshot({ epoch: 1, sequence: 10 }, [taskImage('t_other1', 1)])), 'https://other.example');
    snap(snapshot({ epoch: 1, sequence: 3 }, [taskImage('t_first1', 1)]));
    expect(await pullWorkspace(config)).toMatchObject({ kind: 'bootstrapped', reason: 'first_pull' });
  });

  it('names an unreadable cache as cache_invalid rather than a first pull', async () => {
    await seed();
    const db = await (await import('../../src/idb/db')).getDB();
    await new Promise<void>((resolve, reject) => { const tx = db.transaction('canonical_entities', 'readwrite'); tx.objectStore('canonical_entities').put({ id: 'task:t_bad001', image: { nope: true } }); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    snap(snapshot({ epoch: 1, sequence: 11 }, [taskImage('t_first1', 2)]));
    expect(await pullWorkspace(config)).toMatchObject({ kind: 'bootstrapped', reason: 'cache_invalid' });
    expect((await read())?.cursor.sequence).toBe(11);
  });

  it('falls back to a snapshot when the backlog exceeds the page bound instead of failing forever', async () => {
    await seed();
    delta(page(10, 11, 13, true, [[11, taskImage('t_first1', 2)]]).raw);
    delta(page(11, 12, 13, true, [[12, taskImage('t_first1', 3)]]).raw);
    snap(snapshot({ epoch: 1, sequence: 13 }, [taskImage('t_first1', 4)]));
    expect(await pullWorkspace(config, { maxPages: 2 })).toMatchObject({ kind: 'bootstrapped', reason: 'backlog' });
    expect((await read())?.entities.get('task:t_first1')?.revision).toBe(4);
  });

  it('skips re-reading the store while the stored cursor still matches the validated copy', async () => {
    await seed();
    delta(page(10, 10, 10, false, []).raw); delta(page(10, 10, 10, false, []).raw);
    expect((await pullWorkspace(config)).kind).toBe('unchanged');
    // Tamper below the cursor: a full re-read would reject it; the cached copy is still current.
    const db = await (await import('../../src/idb/db')).getDB();
    await new Promise<void>((resolve, reject) => { const tx = db.transaction('canonical_entities', 'readwrite'); tx.objectStore('canonical_entities').put({ id: 'task:t_bad001', image: { nope: true } }); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
    expect((await pullWorkspace(config)).kind).toBe('unchanged');
  });

  it('reconciles against a concurrent commit by another tab and retries once', async () => {
    await seed();
    delta(page(10, 11, 11, false, [[11, taskImage('t_first1', 2)]]).raw);
    delta(page(12, 12, 12, false, []).raw);
    const real = api.workspaceDelta.bind(api);
    vi.spyOn(api, 'workspaceDelta').mockImplementationOnce(async (...args) => {
      const result = await real(...args);
      await idbReplaceCanonical(canonicalFromSnapshot(snapshot({ epoch: 1, sequence: 12 }, [taskImage('t_first1', 3), projectImage('p_first1', 1)])), SRC);
      return result;
    });
    expect((await pullWorkspace(config)).kind).toBe('unchanged');
    const stored = await read();
    expect(stored?.cursor.sequence).toBe(12);
    expect(stored?.entities.get('task:t_first1')?.revision).toBe(3);
  });

  it('reports storage failures as a failed outcome instead of rejecting', async () => {
    closeDb();
    vi.spyOn(indexedDB, 'open').mockImplementation(() => { throw new DOMException('Storage is unavailable', 'InvalidStateError'); });
    const outcome = await pullWorkspace(config);
    expect(outcome).toMatchObject({ kind: 'failed', result: { kind: 'storage', message: expect.stringContaining('unavailable') } });
  });

  it('shares one pull between concurrent callers with the same credentials', async () => {
    snap(snapshot({ epoch: 1, sequence: 10 }, [taskImage('t_first1', 1)]));
    const [a, b] = await Promise.all([pullWorkspace(config), pullWorkspace(config)]);
    expect(a).toBe(b);
    expect(stub.calls).toHaveLength(1);
  });

  it('runs a fresh pull after the in-flight one, and never shares across credentials', async () => {
    await seed();
    delta(page(10, 11, 11, false, [[11, taskImage('t_first1', 2)]]).raw);
    delta(page(11, 12, 12, false, [[12, taskImage('t_first1', 3)]]).raw);
    const first = pullWorkspace(config);
    const trailing = pullWorkspace(config, { fresh: true });
    expect(trailing).not.toBe(first);
    expect(await first).toMatchObject({ kind: 'updated' });
    expect(await trailing).toMatchObject({ kind: 'updated' });
    expect((await read())?.cursor.sequence).toBe(12);
    expect(stub.calls).toHaveLength(2);
    delta(page(12, 12, 12, false, []).raw); delta(page(12, 12, 12, false, []).raw);
    const [a, b] = [pullWorkspace(config), pullWorkspace({ ...config, authToken: 'other' })];
    expect(a).not.toBe(b);
    await Promise.all([a, b]);
  });

  it('leaves storage empty when the first bootstrap fails', async () => {
    stub.networkError({ method: 'GET', path: '/api/v2/sync/snapshot' });
    expect((await pullWorkspace(config)).kind).toBe('failed');
    expect(await read()).toBeNull();
  });

  it('keeps stored state and flags an upgrade when the server refuses the feed with 426', async () => {
    await seed();
    consumeUpgradeRequired();
    delta({ error: 'upgrade_required', minimumProtocol: 3, clientProtocol: 2 }, 426);
    const outcome = await pullWorkspace(config);
    expect(outcome.kind).toBe('failed');
    expect(consumeUpgradeRequired()).toBe(true);
    const stored = await read();
    expect(stored?.cursor).toEqual({ epoch: 1, sequence: 10 });
    expect(stored?.entities.get('task:t_first1')?.revision).toBe(1);
  });
});
