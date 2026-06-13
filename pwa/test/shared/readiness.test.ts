import { describe, test, expect } from 'vitest';
import fc from 'fast-check';
import {
  isDeferred,
  isFocused,
  hasActiveBlocker,
  isReady,
  readinessScore,
} from '@shared/readiness';
import { makeTask, makeLink } from '../helpers/fixtures';

const NOW = '2026-06-09T12:00:00.000Z';
const FUTURE = '2026-12-31T00:00:00.000Z';
const PAST = '2026-01-01T00:00:00.000Z';
const TODAY = NOW.slice(0, 10);

describe('isDeferred', () => {
  test('someday → true regardless of defer_until', () => {
    expect(isDeferred(makeTask({ defer_kind: 'someday', defer_until: null }), NOW)).toBe(true);
  });

  test('until with future defer_until → true', () => {
    expect(isDeferred(makeTask({ defer_kind: 'until', defer_until: FUTURE }), NOW)).toBe(true);
  });

  test('until with past defer_until → false', () => {
    expect(isDeferred(makeTask({ defer_kind: 'until', defer_until: PAST }), NOW)).toBe(false);
  });

  test('expired earlier the same day → false', () => {
    const deferUntil = '2026-06-09T09:00:00.000Z'; // 09:00, nowIso is 12:00
    expect(isDeferred(makeTask({ defer_kind: 'until', defer_until: deferUntil }), NOW)).toBe(false);
  });

  test('none with stale defer_until → false', () => {
    expect(isDeferred(makeTask({ defer_kind: 'none', defer_until: PAST }), NOW)).toBe(false);
  });
});

describe('isFocused', () => {
  test('focused_until in future → true', () => {
    expect(isFocused(makeTask({ focused_until: FUTURE }), NOW)).toBe(true);
  });

  test('focused_until in past → false', () => {
    expect(isFocused(makeTask({ focused_until: PAST }), NOW)).toBe(false);
  });

  test('null focused_until → false', () => {
    expect(isFocused(makeTask({ focused_until: null }), NOW)).toBe(false);
  });

  test('expired earlier the same day → false', () => {
    const focusedUntil = '2026-06-09T09:00:00.000Z';
    expect(isFocused(makeTask({ focused_until: focusedUntil }), NOW)).toBe(false);
  });
});

describe('hasActiveBlocker', () => {
  test('pending blocker → true', () => {
    const task = makeTask({ id: 't_target' });
    const blocker = makeTask({ id: 't_blocker', status: 'pending' });
    const link = makeLink({ from_task_id: 't_blocker', to_task_id: 't_target', link_type: 'blocks' });
    expect(hasActiveBlocker(task, [link], [task, blocker])).toBe(true);
  });

  test('done blocker → false', () => {
    const task = makeTask({ id: 't_target' });
    const blocker = makeTask({ id: 't_blocker', status: 'done' });
    const link = makeLink({ from_task_id: 't_blocker', to_task_id: 't_target', link_type: 'blocks' });
    expect(hasActiveBlocker(task, [link], [task, blocker])).toBe(false);
  });

  test('related links are ignored', () => {
    const task = makeTask({ id: 't_target' });
    const other = makeTask({ id: 't_other', status: 'pending' });
    const link = makeLink({ from_task_id: 't_other', to_task_id: 't_target', link_type: 'related' });
    expect(hasActiveBlocker(task, [link], [task, other])).toBe(false);
  });

  test('blocker missing from task list → false', () => {
    const task = makeTask({ id: 't_target' });
    const link = makeLink({ from_task_id: 't_ghost', to_task_id: 't_target', link_type: 'blocks' });
    expect(hasActiveBlocker(task, [link], [task])).toBe(false);
  });
});

describe('isReady', () => {
  test('pending, not deferred, not blocked → true', () => {
    const task = makeTask();
    expect(isReady(task, [], [], NOW)).toBe(true);
  });

  test('done status → false', () => {
    expect(isReady(makeTask({ status: 'done' }), [], [], NOW)).toBe(false);
  });

  test('deferred → false', () => {
    expect(isReady(makeTask({ defer_kind: 'someday' }), [], [], NOW)).toBe(false);
  });

  test('active blocker → false', () => {
    const task = makeTask({ id: 't_target' });
    const blocker = makeTask({ id: 't_blocker', status: 'pending' });
    const link = makeLink({ from_task_id: 't_blocker', to_task_id: 't_target', link_type: 'blocks' });
    expect(isReady(task, [link], [task, blocker], NOW)).toBe(false);
  });
});

describe('readinessScore', () => {
  test('done → 0', () => {
    expect(readinessScore(makeTask({ status: 'done' }), NOW)).toBe(0);
  });

  test('active blocker → 5', () => {
    const task = makeTask({ id: 't_target' });
    const blocker = makeTask({ id: 't_blocker', status: 'pending' });
    const link = makeLink({ from_task_id: 't_blocker', to_task_id: 't_target', link_type: 'blocks' });
    expect(readinessScore(task, NOW, [link], [task, blocker])).toBe(5);
  });

  test('kickoff_note adds 20 to base', () => {
    // base: 10, kickoff: +20
    const old = '2025-01-01T00:00:00.000Z';
    const base = readinessScore(makeTask({ updated_at: old }), NOW);
    const withKickoff = readinessScore(makeTask({ kickoff_note: 'kick', updated_at: old }), NOW);
    expect(withKickoff - base).toBe(20);
  });

  test('session_log adds 15 to base', () => {
    const old = '2025-01-01T00:00:00.000Z';
    const base = readinessScore(makeTask({ updated_at: old }), NOW);
    const withLog = readinessScore(makeTask({ session_log: 'log', updated_at: old }), NOW);
    expect(withLog - base).toBe(15);
  });

  test('focused adds 12 to base', () => {
    const old = '2025-01-01T00:00:00.000Z';
    const base = readinessScore(makeTask({ updated_at: old }), NOW);
    const withFocus = readinessScore(makeTask({ focused_until: FUTURE, updated_at: old }), NOW);
    expect(withFocus - base).toBe(12);
  });

  test('updated within 14 days adds 8', () => {
    const recent = '2026-06-08T00:00:00.000Z'; // 1 day ago
    const old = '2025-01-01T00:00:00.000Z';
    const withRecent = readinessScore(makeTask({ updated_at: recent }), NOW);
    const withOld = readinessScore(makeTask({ updated_at: old }), NOW);
    expect(withRecent - withOld).toBe(8);
  });

  test('overdue due_date adds 10', () => {
    const old = '2025-01-01T00:00:00.000Z';
    const base = readinessScore(makeTask({ updated_at: old }), NOW);
    const overdue = readinessScore(makeTask({ due_date: '2026-06-01', updated_at: old }), NOW);
    expect(overdue - base).toBe(10);
  });

  test('due today adds 7', () => {
    const old = '2025-01-01T00:00:00.000Z';
    const base = readinessScore(makeTask({ updated_at: old }), NOW);
    const today = readinessScore(makeTask({ due_date: TODAY, updated_at: old }), NOW);
    expect(today - base).toBe(7);
  });

  test('due within 7 days adds 3', () => {
    const old = '2025-01-01T00:00:00.000Z';
    const base = readinessScore(makeTask({ updated_at: old }), NOW);
    const soon = readinessScore(makeTask({ due_date: '2026-06-15', updated_at: old }), NOW);
    expect(soon - base).toBe(3);
  });

  test('score is always ≥ 0 and ≤ 75', () => {
    const old = '2025-01-01T00:00:00.000Z';
    fc.assert(
      fc.property(
        fc.record({
          kickoff_note: fc.option(fc.string(), { nil: null }),
          session_log: fc.option(fc.string(), { nil: null }),
          due_date: fc.option(
            fc.constantFrom('2026-06-01', TODAY, '2026-06-15', '2026-12-31'),
            { nil: null },
          ),
          focused_until: fc.option(fc.constantFrom(FUTURE, PAST), { nil: null }),
        }),
        (fields) => {
          const task = makeTask({ ...fields, status: 'pending', updated_at: old });
          const score = readinessScore(task, NOW);
          return score >= 0 && score <= 75;
        },
      ),
    );
  });
});
