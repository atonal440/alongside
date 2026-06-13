import { describe, test, expect } from 'vitest';
import { genId } from '../../src/utils/genId';
import { buildBlocksMap, buildBlockedByMap } from '../../src/utils/linkMaps';
import { suggestQueue } from '../../src/utils/suggestQueue';
import { makeTask, makeLink } from '../helpers/fixtures';

// suggestQueue calls new Date() internally — the `_today` param it accepts is unused.
// Time isolation strategy: use OLD for updated_at (> 14 days ago → no recent-update bonus,
// stable scores regardless of when tests run), and FAR_FUTURE for defer_until / focused_until
// so those states are always active. This avoids injectable-time refactoring suggestQueue
// while still exercising its filtering and ordering contracts reliably.
const OLD = '2025-01-01T00:00:00.000Z';
const FAR_FUTURE = '2099-12-31T00:00:00.000Z';

describe('genId', () => {
  test('default prefix produces t_xxxxx format', () => {
    expect(genId()).toMatch(/^t_[0-9A-Za-z_-]{5}$/);
  });

  test('custom prefix is honored', () => {
    expect(genId('p')).toMatch(/^p_[0-9A-Za-z_-]{5}$/);
  });

  test('generates unique ids', () => {
    const ids = new Set(Array.from({ length: 100 }, () => genId()));
    expect(ids.size).toBe(100);
  });
});

describe('buildBlocksMap', () => {
  test('empty links → empty map', () => {
    expect(buildBlocksMap([])).toEqual({});
  });

  test('blocks link: from_task_id → Set containing to_task_id', () => {
    const link = makeLink({ from_task_id: 't_a', to_task_id: 't_b', link_type: 'blocks' });
    const map = buildBlocksMap([link]);
    expect(map['t_a']?.has('t_b')).toBe(true);
  });

  test('related links are excluded', () => {
    const link = makeLink({ from_task_id: 't_a', to_task_id: 't_b', link_type: 'related' });
    const map = buildBlocksMap([link]);
    expect(map['t_a']).toBeUndefined();
  });

  test('multiple targets for same source', () => {
    const l1 = makeLink({ from_task_id: 't_a', to_task_id: 't_b', link_type: 'blocks' });
    const l2 = makeLink({ from_task_id: 't_a', to_task_id: 't_c', link_type: 'blocks' });
    const map = buildBlocksMap([l1, l2]);
    expect(map['t_a']?.size).toBe(2);
  });
});

describe('buildBlockedByMap', () => {
  test('blocks link: to_task_id → Set containing from_task_id', () => {
    const link = makeLink({ from_task_id: 't_a', to_task_id: 't_b', link_type: 'blocks' });
    const map = buildBlockedByMap([link]);
    expect(map['t_b']?.has('t_a')).toBe(true);
  });

  test('related links are excluded', () => {
    const link = makeLink({ from_task_id: 't_a', to_task_id: 't_b', link_type: 'related' });
    const map = buildBlockedByMap([link]);
    expect(map['t_b']).toBeUndefined();
  });
});

describe('suggestQueue', () => {
  test('excludes done tasks', () => {
    const done = makeTask({ id: 't_done', status: 'done', updated_at: OLD });
    const pending = makeTask({ id: 't_pending', updated_at: OLD });
    const queue = suggestQueue([done, pending], '2026-06-09');
    expect(queue.map(t => t.id)).not.toContain('t_done');
    expect(queue.map(t => t.id)).toContain('t_pending');
  });

  test('excludes someday tasks', () => {
    const someday = makeTask({ id: 't_someday', defer_kind: 'someday', updated_at: OLD });
    const pending = makeTask({ id: 't_pending', updated_at: OLD });
    const queue = suggestQueue([someday, pending], '2026-06-09');
    expect(queue.map(t => t.id)).not.toContain('t_someday');
  });

  test('excludes tasks deferred to future', () => {
    const deferred = makeTask({ id: 't_deferred', defer_kind: 'until', defer_until: FAR_FUTURE, updated_at: OLD });
    const pending = makeTask({ id: 't_pending', updated_at: OLD });
    const queue = suggestQueue([deferred, pending], '2026-06-09');
    expect(queue.map(t => t.id)).not.toContain('t_deferred');
  });

  test('excludes tasks with active blockers', () => {
    const blocked = makeTask({ id: 't_blocked', updated_at: OLD });
    const blocker = makeTask({ id: 't_blocker', status: 'pending', updated_at: OLD });
    const link = makeLink({ from_task_id: 't_blocker', to_task_id: 't_blocked', link_type: 'blocks' });
    const queue = suggestQueue([blocked, blocker], '2026-06-09', [link]);
    expect(queue.map(t => t.id)).not.toContain('t_blocked');
  });

  test('higher-scoring task sorts first', () => {
    const high = makeTask({ id: 't_high', kickoff_note: 'kick', updated_at: OLD });
    const low = makeTask({ id: 't_low', kickoff_note: null, updated_at: OLD });
    const queue = suggestQueue([low, high], '2026-06-09');
    expect(queue[0].id).toBe('t_high');
  });

  test('returns empty array when all tasks are filtered', () => {
    const done = makeTask({ status: 'done', updated_at: OLD });
    expect(suggestQueue([done], '2026-06-09')).toHaveLength(0);
  });
});
