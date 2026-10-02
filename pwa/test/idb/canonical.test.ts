import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { resetIdb } from '../helpers/idb';
import { closeDb, getDB } from '../../src/idb/db';
import { idbClearCanonical, idbCommitCanonical, idbReadCanonical, idbReadCanonicalCursor, idbReplaceCanonical, StaleCanonicalError } from '../../src/idb/canonical';
import { applyStagedPull, canonicalFromSnapshot } from '../../src/sync/canonical';
import { page, projectImage, snapshot, taskImage } from '../helpers/syncFixtures';

const SRC = 'http://localhost:8787';
beforeEach(async () => { closeDb(); await resetIdb(); });
afterEach(() => vi.restoreAllMocks());
const initial = () => canonicalFromSnapshot(snapshot({ epoch: 1, sequence: 10 }, [taskImage('t_first1', 1), projectImage('p_first1', 1)], 3));
const put = async (store: string, value: unknown) => {
  const db = await getDB();
  await new Promise<void>((resolve, reject) => { const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(value); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
};

describe('canonical IDB store', () => {
  test('is empty before the first bootstrap', async () => {
    expect(await idbReadCanonical(SRC)).toBeNull();
    expect(await idbReadCanonicalCursor(SRC)).toBeNull();
  });

  test('round-trips a bootstrap with its cursor', async () => {
    await idbReplaceCanonical(initial(), SRC);
    const read = await idbReadCanonical(SRC);
    expect(read?.cursor).toEqual({ epoch: 1, sequence: 10 });
    expect(await idbReadCanonicalCursor(SRC)).toEqual({ epoch: 1, sequence: 10 });
    expect([...read!.entities.keys()].sort()).toEqual(['project:p_first1', 'task:t_first1']);
  });

  test('another server reads as a cache miss', async () => {
    await idbReplaceCanonical(initial(), SRC);
    expect(await idbReadCanonical('https://other.example')).toBeNull();
    expect(await idbReadCanonicalCursor('https://other.example')).toBeNull();
  });

  test('replace discards entities from the previous epoch', async () => {
    await idbReplaceCanonical(initial(), SRC);
    await idbReplaceCanonical(canonicalFromSnapshot(snapshot({ epoch: 2, sequence: 4 }, [taskImage('t_other1', 1)])), SRC);
    const read = await idbReadCanonical(SRC);
    expect(read?.cursor.epoch).toBe(2);
    expect([...read!.entities.keys()]).toEqual(['task:t_other1']);
  });

  test('commit writes only changed images and advances the cursor together', async () => {
    const base = initial();
    await idbReplaceCanonical(base, SRC);
    const next = applyStagedPull(base, [page(10, 11, 11, false, [[11, taskImage('t_first1', 2, { title: 'Renamed' })]]).parsed]);
    if (!next.ok) throw new Error();
    await idbCommitCanonical(next.value, [next.value.entities.get('task:t_first1')!], SRC, base.cursor);
    const read = await idbReadCanonical(SRC);
    expect(read?.cursor.sequence).toBe(11);
    expect(read?.entities.get('task:t_first1')).toMatchObject({ revision: 2, row: { title: 'Renamed' } });
    expect(read?.entities.get('project:p_first1')?.revision).toBe(1);
  });

  test('a commit from a stale base is rejected and changes nothing', async () => {
    const base = initial();
    await idbReplaceCanonical(base, SRC);
    const fast = applyStagedPull(base, [page(10, 13, 13, false, [[13, taskImage('t_first1', 3)]]).parsed]);
    const slow = applyStagedPull(base, [page(10, 11, 11, false, [[11, taskImage('t_first1', 2)]]).parsed]);
    if (!fast.ok || !slow.ok) throw new Error();
    await idbCommitCanonical(fast.value, [fast.value.entities.get('task:t_first1')!], SRC, base.cursor);
    await expect(idbCommitCanonical(slow.value, [slow.value.entities.get('task:t_first1')!], SRC, base.cursor)).rejects.toBeInstanceOf(StaleCanonicalError);
    const read = await idbReadCanonical(SRC);
    expect(read?.cursor.sequence).toBe(13);
    expect(read?.entities.get('task:t_first1')?.revision).toBe(3);
  });

  test('a synchronous put failure rolls the whole replace back, including the clear', async () => {
    await idbReplaceCanonical(initial(), SRC);
    const good = canonicalFromSnapshot(snapshot({ epoch: 2, sequence: 1 }, [taskImage('t_good01', 1)]));
    const entities = new Map(good.entities);
    entities.set('task:t_bad001', { entity: 'task', key: 't_bad001', revision: 1, deletedAt: null, row: () => 1 } as never);
    entities.set('task:t_good02', taskImage('t_good02', 1) as never);
    await expect(idbReplaceCanonical({ ...good, entities }, SRC)).rejects.toBeDefined();
    const read = await idbReadCanonical(SRC);
    expect(read?.cursor).toEqual({ epoch: 1, sequence: 10 });
    expect([...read!.entities.keys()].sort()).toEqual(['project:p_first1', 'task:t_first1']);
  });

  test('a synchronous put failure during commit writes neither images nor the cursor', async () => {
    const base = initial();
    await idbReplaceCanonical(base, SRC);
    const moved = canonicalFromSnapshot(snapshot({ epoch: 1, sequence: 12 }, [taskImage('t_first1', 1), projectImage('p_first1', 1)]));
    const changed = [taskImage('t_good01', 1), { entity: 'task', key: 't_bad001', revision: 1, deletedAt: null, row: () => 1 }] as never;
    await expect(idbCommitCanonical(moved, changed, SRC, base.cursor)).rejects.toBeDefined();
    const read = await idbReadCanonical(SRC);
    expect(read?.cursor.sequence).toBe(10);
    expect(read?.entities.has('task:t_good01')).toBe(false);
  });

  test.each([
    ['invalid metadata', () => put('canonical_meta', { id: 'workspace', source: SRC, cursor: { epoch: 'x' } })],
    ['mismatched identity', () => put('canonical_entities', { id: 'task:t_wrong1', image: taskImage('t_first1', 1) })],
    ['malformed image', () => put('canonical_entities', { id: 'task:t_bad001', image: { entity: 'task', key: 't_bad001' } })],
    ['dangling reference', () => put('canonical_entities', { id: 'task:t_dang01', image: taskImage('t_dang01', 1, { project_id: 'p_missing' }) })],
  ])('treats %s as a cache miss so the caller re-bootstraps', async (_name, corrupt) => {
    await idbReplaceCanonical(initial(), SRC);
    await corrupt();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await idbReadCanonical(SRC)).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  test('clear removes everything', async () => {
    await idbReplaceCanonical(initial(), SRC);
    await idbClearCanonical();
    expect(await idbReadCanonical(SRC)).toBeNull();
  });
});

describe('schema upgrades', () => {
  test('an open connection closes on versionchange so a newer tab can upgrade', async () => {
    const db = await getDB();
    const upgraded = new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('alongside', 6);
      req.onupgradeneeded = () => {};
      req.onsuccess = () => { req.result.close(); resolve(); };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('upgrade was blocked by the old connection'));
    });
    await expect(upgraded).resolves.toBeUndefined();
    expect(db).toBeDefined();
  });
});
