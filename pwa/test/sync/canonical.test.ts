import { describe, expect, it } from 'vitest';
import { applyStagedPull, canonicalFromSnapshot, changedImages, danglingReference, entityId } from '../../src/sync/canonical';
import { page, projectImage, snapshot, taskImage, tombstone } from '../helpers/syncFixtures';

const base = () => canonicalFromSnapshot(snapshot({ epoch: 1, sequence: 10 }, [taskImage('t_first1', 1), projectImage('p_first1', 1)]));

describe('canonical workspace reconciliation', () => {
  it('builds identity-keyed state from a snapshot, retaining tombstones', () => {
    const canonical = canonicalFromSnapshot(snapshot({ epoch: 1, sequence: 10 }, [taskImage('t_first1', 1), tombstone('task', 't_gone01', 5)]));
    expect([...canonical.entities.keys()].sort()).toEqual(['task:t_first1', 'task:t_gone01']);
    expect(canonical.entities.get('task:t_gone01')?.row).toBeNull();
    expect(canonical.cursor).toEqual({ epoch: 1, sequence: 10 });
  });

  it('applies a multi-page pull, advancing revisions, tombstoning and moving the cursor', () => {
    const first = page(10, 11, 12, true, [[11, taskImage('t_first1', 2, { title: 'Renamed' })]]);
    const last = page(11, 12, 12, false, [[12, tombstone('project', 'p_first1', 2)]]);
    const result = applyStagedPull(base(), [first.parsed, last.parsed]);
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    expect(result.value.cursor).toEqual({ epoch: 1, sequence: 12 });
    expect(result.value.entities.get('task:t_first1')).toMatchObject({ revision: 2, row: { title: 'Renamed' } });
    expect(result.value.entities.get('project:p_first1')).toMatchObject({ revision: 2, row: null });
  });

  it('tolerates references that dangle between pages but resolve in the final state', () => {
    const early = page(10, 11, 12, true, [[11, taskImage('t_new001', 1, { project_id: 'p_late01' })]]);
    const late = page(11, 12, 12, false, [[12, projectImage('p_late01', 1)]]);
    expect(applyStagedPull(base(), [early.parsed, late.parsed]).ok).toBe(true);
  });

  it('rejects a final state that still dangles, naming the reference', () => {
    const only = page(10, 11, 11, false, [[11, taskImage('t_new001', 1, { project_id: 'p_nope01' })]]);
    const result = applyStagedPull(base(), [only.parsed]);
    expect(result).toMatchObject({ ok: false, error: [{ code: 'dangling_reference' }] });
  });

  it('rejects a missing parent, a deleted parent and a hierarchy loop', () => {
    const orphan = page(10, 11, 11, false, [[11, taskImage('t_new001', 1, { parent_id: 't_nope01' })]]);
    expect(applyStagedPull(base(), [orphan.parsed])).toMatchObject({ ok: false, error: [{ code: 'dangling_reference' }] });
    const withChild = canonicalFromSnapshot(snapshot({ epoch: 1, sequence: 10 }, [taskImage('t_first1', 1), taskImage('t_kid001', 1, { parent_id: 't_first1' })]));
    const removed = page(10, 11, 11, false, [[11, tombstone('task', 't_first1', 2)]]);
    expect(applyStagedPull(withChild, [removed.parsed])).toMatchObject({ ok: false, error: [{ code: 'dangling_reference' }] });
    const loop = page(10, 11, 11, false, [[11, taskImage('t_first1', 2, { parent_id: 't_kid001' })]]);
    expect(applyStagedPull(withChild, [loop.parsed])).toMatchObject({ ok: false, error: [{ code: 'dangling_reference' }] });
  });

  it('rejects deleting a project that a live task still references', () => {
    const only = page(10, 11, 11, false, [[11, tombstone('project', 'p_first1', 2)]]);
    const withMember = canonicalFromSnapshot(snapshot({ epoch: 1, sequence: 10 }, [taskImage('t_first1', 1, { project_id: 'p_first1' }), projectImage('p_first1', 1)]));
    expect(applyStagedPull(withMember, [only.parsed])).toMatchObject({ ok: false, error: [{ code: 'dangling_reference' }] });
  });

  it.each([
    ['revision regression', () => [page(10, 11, 11, false, [[11, taskImage('t_first1', 1)]]).parsed], 'revision_regressed'],
    ['equal revision', () => [page(10, 11, 11, false, [[11, taskImage('t_first1', 1, { title: 'Same rev' })]]).parsed], 'revision_regressed'],
    ['wrong starting cursor', () => [page(9, 11, 11, false, [[11, taskImage('t_new001', 1)]]).parsed], 'discontinuous_pull'],
    ['gap between pages', () => [page(10, 11, 13, true, [[11, taskImage('t_new001', 1)]]).parsed, page(12, 13, 13, false, [[13, taskImage('t_new002', 1)]]).parsed], 'discontinuous_pull'],
    ['moved watermark', () => [page(10, 11, 12, true, [[11, taskImage('t_new001', 1)]]).parsed, page(11, 13, 13, false, [[12, taskImage('t_new002', 1)], [13, taskImage('t_new003', 1)]]).parsed], 'watermark_moved'],
    ['incomplete pull', () => [page(10, 11, 12, true, [[11, taskImage('t_new001', 1)]]).parsed], 'incomplete_pull'],
    ['no pages', () => [], 'empty_pull'],
    ['other epoch', () => [page(10, 11, 11, false, [[11, taskImage('t_new001', 1)]], 2).parsed], 'discontinuous_pull'],
  ])('rejects %s without touching the base', (_name, pages, code) => {
    const start = base();
    const before = new Map(start.entities);
    expect(applyStagedPull(start, pages())).toMatchObject({ ok: false, error: [{ code }] });
    expect(start.entities).toEqual(before);
  });

  it('reports exactly the changed images', () => {
    const start = base();
    const next = applyStagedPull(start, [page(10, 11, 11, false, [[11, taskImage('t_first1', 2)]]).parsed]);
    if (!next.ok) throw new Error();
    expect(changedImages(start, next.value).map(entityId)).toEqual(['task:t_first1']);
    expect(danglingReference(next.value.entities)).toBeNull();
  });
});
