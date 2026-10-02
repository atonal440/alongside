import { describe, test, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { resetIdb } from '../helpers/idb';
import { closeDb, getDB } from '../../src/idb/db';
import { idbClearCanonical, idbCommitCanonical, idbReadCanonical, idbReplaceCanonical } from '../../src/idb/canonical';
import { applyStagedPull, canonicalFromSnapshot } from '../../src/sync/canonical';
import { page, projectImage, snapshot, taskImage } from '../helpers/syncFixtures';

beforeEach(async () => { closeDb(); await resetIdb(); });
const initial = () => canonicalFromSnapshot(snapshot({ epoch: 1, sequence: 10 }, [taskImage('t_first1', 1), projectImage('p_first1', 1)], 3));
const put = async (store: string, value: unknown) => {
  const db = await getDB();
  await new Promise<void>((resolve, reject) => { const tx = db.transaction(store, 'readwrite'); tx.objectStore(store).put(value); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
};

describe('canonical IDB store', () => {
  test('is empty before the first bootstrap', async () => { expect(await idbReadCanonical()).toBeNull(); });

  test('round-trips a bootstrap with cursor and structural revision', async () => {
    await idbReplaceCanonical(initial());
    const read = await idbReadCanonical();
    expect(read?.cursor).toEqual({ epoch: 1, sequence: 10 });
    expect(read?.structuralRevision).toBe(3);
    expect([...read!.entities.keys()].sort()).toEqual(['project:p_first1', 'task:t_first1']);
  });

  test('replace discards entities from the previous epoch', async () => {
    await idbReplaceCanonical(initial());
    await idbReplaceCanonical(canonicalFromSnapshot(snapshot({ epoch: 2, sequence: 4 }, [taskImage('t_other1', 1)])));
    const read = await idbReadCanonical();
    expect(read?.cursor.epoch).toBe(2);
    expect([...read!.entities.keys()]).toEqual(['task:t_other1']);
  });

  test('commit writes only changed images and advances the cursor together', async () => {
    const base = initial();
    await idbReplaceCanonical(base);
    const next = applyStagedPull(base, [page(10, 11, 11, false, [[11, taskImage('t_first1', 2, { title: 'Renamed' })]]).parsed]);
    if (!next.ok) throw new Error();
    await idbCommitCanonical(next.value, [next.value.entities.get('task:t_first1')!]);
    const read = await idbReadCanonical();
    expect(read?.cursor.sequence).toBe(11);
    expect(read?.entities.get('task:t_first1')).toMatchObject({ revision: 2, row: { title: 'Renamed' } });
    expect(read?.entities.get('project:p_first1')?.revision).toBe(1);
  });

  test('a failed transaction leaves cursor and entities untouched', async () => {
    await idbReplaceCanonical(initial());
    const broken = canonicalFromSnapshot(snapshot({ epoch: 1, sequence: 99 }, [taskImage('t_first1', 1), projectImage('p_first1', 1)]));
    // An unserializable image aborts the transaction after the meta put was queued.
    await expect(idbCommitCanonical(broken, [{ entity: 'task', key: 't_bad001', revision: 1, deletedAt: null, row: () => 1 } as never])).rejects.toBeDefined();
    expect((await idbReadCanonical())?.cursor.sequence).toBe(10);
  });

  test.each([
    ['invalid metadata', () => put('canonical_meta', { id: 'workspace', cursor: { epoch: 'x' } })],
    ['mismatched identity', () => put('canonical_entities', { id: 'task:t_wrong1', image: taskImage('t_first1', 1) })],
    ['malformed image', () => put('canonical_entities', { id: 'task:t_bad001', image: { entity: 'task', key: 't_bad001' } })],
    ['dangling reference', () => put('canonical_entities', { id: 'task:t_dang01', image: taskImage('t_dang01', 1, { project_id: 'p_missing' }) })],
  ])('treats %s as a cache miss so the caller re-bootstraps', async (_name, corrupt) => {
    await idbReplaceCanonical(initial());
    await corrupt();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await idbReadCanonical()).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('clear removes everything', async () => {
    await idbReplaceCanonical(initial());
    await idbClearCanonical();
    expect(await idbReadCanonical()).toBeNull();
  });
});
