import { describe, test, expect } from 'vitest';
import fc from 'fast-check';
import {
  isFocused,
  isDeferred,
  formatDue,
  projectColor,
  projectTitle,
  firstNoteEntry,
  readinessScore,
  taskSort,
} from '../../src/utils/design';
import { makeTask, makeProject } from '../helpers/fixtures';

const NOW = '2026-06-09T12:00:00.000Z';
const TODAY = '2026-06-09';
const FUTURE = '2026-12-31T00:00:00.000Z';
const OLD_UPDATED = '2025-01-01T00:00:00.000Z';

describe('isFocused', () => {
  test('future focused_until → true', () => {
    expect(isFocused(makeTask({ focused_until: FUTURE }), NOW)).toBe(true);
  });

  test('null focused_until → false', () => {
    expect(isFocused(makeTask({ focused_until: null }), NOW)).toBe(false);
  });

  test('expired earlier the same day → false', () => {
    expect(isFocused(makeTask({ focused_until: '2026-06-09T09:00:00.000Z' }), NOW)).toBe(false);
  });
});

describe('isDeferred', () => {
  test('someday → true', () => {
    expect(isDeferred(makeTask({ defer_kind: 'someday' }), NOW)).toBe(true);
  });

  test('until in past → false', () => {
    expect(isDeferred(makeTask({ defer_kind: 'until', defer_until: '2026-01-01T00:00:00.000Z' }), NOW)).toBe(false);
  });
});

describe('formatDue', () => {
  test('no due date → empty string', () => {
    expect(formatDue(makeTask({ due_date: null }), TODAY)).toBe('');
  });

  test('past due date → Overdue prefix', () => {
    expect(formatDue(makeTask({ due_date: '2026-06-01' }), TODAY)).toBe('Overdue 2026-06-01');
  });

  test('due today → "Due today"', () => {
    expect(formatDue(makeTask({ due_date: TODAY }), TODAY)).toBe('Due today');
  });

  test('future due date → "Due YYYY-MM-DD"', () => {
    expect(formatDue(makeTask({ due_date: '2026-07-01' }), TODAY)).toBe('Due 2026-07-01');
  });
});

describe('projectColor', () => {
  test('null → default color', () => {
    expect(projectColor(null)).toBe('#9C8472');
  });

  test('undefined → default color', () => {
    expect(projectColor(undefined)).toBe('#9C8472');
  });

  test('same id → same color deterministically', () => {
    expect(projectColor('p_abc')).toBe(projectColor('p_abc'));
  });

  test('falls within the palette', () => {
    const palette = ['#3A6280', '#4A7C5A', '#8B6BAE', '#9C8472', '#C0622A'];
    expect(palette).toContain(projectColor('p_abc'));
  });
});

describe('projectTitle', () => {
  test('no project_id → "No project"', () => {
    expect(projectTitle(makeTask({ project_id: null }), [])).toBe('No project');
  });

  test('project not in list → "No project"', () => {
    expect(projectTitle(makeTask({ project_id: 'p_missing' }), [])).toBe('No project');
  });

  test('project in list → project title', () => {
    const p = makeProject({ id: 'p_1', title: 'My project' });
    expect(projectTitle(makeTask({ project_id: 'p_1' }), [p])).toBe('My project');
  });
});

describe('firstNoteEntry', () => {
  test('null → empty string', () => {
    expect(firstNoteEntry(null)).toBe('');
  });

  test('empty string → empty string', () => {
    expect(firstNoteEntry('')).toBe('');
  });

  test('single paragraph → that paragraph trimmed', () => {
    expect(firstNoteEntry('  Hello world  ')).toBe('Hello world');
  });

  test('two paragraphs → first only', () => {
    expect(firstNoteEntry('First\n\nSecond')).toBe('First');
  });

  test('three blank lines split too', () => {
    expect(firstNoteEntry('First\n\n\nThird')).toBe('First');
  });
});

describe('taskSort', () => {
  test('higher readiness score comes first', () => {
    const a = makeTask({ id: 't_a', kickoff_note: 'kick', updated_at: OLD_UPDATED });
    const b = makeTask({ id: 't_b', updated_at: OLD_UPDATED });
    expect(taskSort(a, b, TODAY, [])).toBeLessThan(0); // a sorts before b
  });

  test('equal readiness: earlier due date comes first', () => {
    const a = makeTask({ id: 't_a', due_date: '2026-07-01', updated_at: OLD_UPDATED });
    const b = makeTask({ id: 't_b', due_date: '2026-08-01', updated_at: OLD_UPDATED });
    expect(taskSort(a, b, TODAY, [])).toBeLessThan(0);
  });

  test('no due date sorts last (after tasks with due dates)', () => {
    const a = makeTask({ id: 't_a', due_date: '2026-07-01', updated_at: OLD_UPDATED });
    const b = makeTask({ id: 't_b', due_date: null, updated_at: OLD_UPDATED });
    expect(taskSort(a, b, TODAY, [])).toBeLessThan(0);
  });

  test('equal readiness and due date: title alphabetical', () => {
    const a = makeTask({ id: 't_a', title: 'Alpha', updated_at: OLD_UPDATED });
    const b = makeTask({ id: 't_b', title: 'Bravo', updated_at: OLD_UPDATED });
    expect(taskSort(a, b, TODAY, [])).toBeLessThan(0);
  });

  test('comparator is antisymmetric for arbitrary task pairs', () => {
    fc.assert(
      fc.property(
        fc.record({
          kickoff_note: fc.option(fc.string({ minLength: 1 }), { nil: null }),
          due_date: fc.option(fc.constantFrom('2026-06-01', TODAY, '2026-07-01', null), { nil: null }),
          title: fc.string({ minLength: 1 }),
        }),
        fc.record({
          kickoff_note: fc.option(fc.string({ minLength: 1 }), { nil: null }),
          due_date: fc.option(fc.constantFrom('2026-06-01', TODAY, '2026-07-01', null), { nil: null }),
          title: fc.string({ minLength: 1 }),
        }),
        (aFields, bFields) => {
          const a = makeTask({ id: 't_a', updated_at: OLD_UPDATED, ...aFields });
          const b = makeTask({ id: 't_b', updated_at: OLD_UPDATED, ...bFields });
          const ab = taskSort(a, b, TODAY, [], [a, b], NOW);
          const ba = taskSort(b, a, TODAY, [], [b, a], NOW);
          return Math.sign(ab) === -Math.sign(ba) || (ab === 0 && ba === 0);
        },
      ),
    );
  });
});

describe('readinessScore', () => {
  test('_today is ignored — passing wrong today does not change the score', () => {
    const task = makeTask({ kickoff_note: 'kick', updated_at: OLD_UPDATED });
    // _today is ignored by the wrapper; both calls should produce identical scores
    expect(readinessScore(task, '1970-01-01', [], [], NOW)).toBe(readinessScore(task, '9999-99-99', [], [], NOW));
  });

  test('nowIso controls focus evaluation, not _today', () => {
    // focused_until at 09:00; nowIso is 12:00 same day → not focused
    const notFocused = makeTask({ focused_until: '2026-06-09T09:00:00.000Z', updated_at: OLD_UPDATED });
    // focused_until at 15:00; nowIso is 12:00 → focused (+12)
    const focused = makeTask({ focused_until: '2026-06-09T15:00:00.000Z', updated_at: OLD_UPDATED });
    expect(readinessScore(focused, TODAY, [], [], NOW) - readinessScore(notFocused, TODAY, [], [], NOW)).toBe(12);
  });

  test('produces expected absolute score for a known task', () => {
    // base 10, kickoff +20, updated_at > 14 days ago (0), no due_date (0) = 30
    const task = makeTask({ kickoff_note: 'kick', updated_at: OLD_UPDATED });
    expect(readinessScore(task, TODAY, [], [], NOW)).toBe(30);
  });
});
