import { describe, test, expect } from 'vitest';
import * as fc from 'fast-check';
import { makeTask } from '../helpers/fixtures';
import type { NonEmptyString, IsoDate, IsoDateTime, Rrule, BoundedString } from '@shared/parse';
import {
  newLocalTask,
  applyUpdate,
  applyComplete,
  applyDefer,
  applyClearDefer,
  applyFocus,
  applyUnfocus,
  applyReopen,
} from '../../src/domain/taskMutations';

const NOW = '2026-06-18T12:00:00.000Z' as IsoDateTime;
const LATER = '2026-06-18T15:00:00.000Z' as IsoDateTime;

// ─── newLocalTask ─────────────────────────────────────────────────────────────

describe('newLocalTask', () => {
  test('produces a pending task with expected defaults', () => {
    const task = newLocalTask('Buy milk' as NonEmptyString<200>, NOW, 't_abc01');
    expect(task.id).toBe('t_abc01');
    expect(task.title).toBe('Buy milk');
    expect(task.status).toBe('pending');
    expect(task.defer_kind).toBe('none');
    expect(task.defer_until).toBeNull();
    expect(task.focused_until).toBeNull();
    expect(task.created_at).toBe(NOW);
    expect(task.updated_at).toBe(NOW);
    expect(task.recurrence).toBeNull();
    expect(task.task_type).toBe('action');
  });
});

// ─── applyUpdate ──────────────────────────────────────────────────────────────

describe('applyUpdate', () => {
  test('patches content fields and stamps updated_at', () => {
    const task = makeTask({ title: 'Old', notes: null });
    const result = applyUpdate(task, { title: 'New' as NonEmptyString<200>, notes: 'some notes' as BoundedString<10000> }, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.task.title).toBe('New');
    expect(result.value.task.notes).toBe('some notes');
    expect(result.value.task.updated_at).toBe(NOW);
  });

  test('body matches updated row fields (no updated_at drift)', () => {
    const task = makeTask({ title: 'Old', due_date: '2026-07-01' });
    const patch = { title: 'New' as NonEmptyString<200>, due_date: null, recurrence: null };
    const result = applyUpdate(task, patch, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { task: updated, body } = result.value;
    // Applying body fields on top of original should yield the updated task
    // (minus updated_at which is stamped by the mutation).
    expect(updated.title).toBe(body.title);
    expect(updated.due_date).toBe(body.due_date);
  });

  test('property: body fields equal updated task fields for arbitrary pending tasks', () => {
    fc.assert(fc.property(
      fc.record({
        title: fc.string({ minLength: 1, maxLength: 10 }),
        notes: fc.option(fc.string(), { nil: null }),
      }),
      (rawPatch) => {
        const patch = rawPatch as { title: NonEmptyString<200>; notes: BoundedString<10000> | null };
        const task = makeTask();
        const result = applyUpdate(task, patch, NOW);
        if (!result.ok) return true; // guard fired — irrelevant for this property
        const { task: updated, body } = result.value;
        if (patch.title !== undefined) expect(updated.title).toBe(body.title);
        if ('notes' in patch) expect(updated.notes).toBe(body.notes);
        return true;
      },
    ));
  });

  test('setting recurrence without due_date → recurrence_requires_due_date', () => {
    const task = makeTask({ due_date: null, recurrence: null });
    const result = applyUpdate(task, { recurrence: 'FREQ=DAILY' as Rrule }, NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('recurrence_requires_due_date');
  });

  test('clearing due_date on a recurring task → recurrence_requires_due_date', () => {
    const task = makeTask({ due_date: '2026-07-01', recurrence: 'FREQ=DAILY' });
    const result = applyUpdate(task, { due_date: null }, NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('recurrence_requires_due_date');
  });

  test('clearing recurrence while also clearing due_date → ok', () => {
    const task = makeTask({ due_date: '2026-07-01', recurrence: 'FREQ=DAILY' });
    const result = applyUpdate(task, { due_date: null, recurrence: null }, NOW);
    expect(result.ok).toBe(true);
  });

  test('setting both recurrence and due_date together → ok', () => {
    const task = makeTask({ due_date: null, recurrence: null });
    const result = applyUpdate(task, { due_date: '2026-07-01' as IsoDate, recurrence: 'FREQ=WEEKLY' as Rrule }, NOW);
    expect(result.ok).toBe(true);
  });
});

// ─── applyComplete ────────────────────────────────────────────────────────────

describe('applyComplete', () => {
  test('marks pending task done', () => {
    const task = makeTask({ status: 'pending' });
    const result = applyComplete(task, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.task.status).toBe('done');
    expect(result.value.task.updated_at).toBe(NOW);
  });

  test('reports wasRecurring=true for recurring task', () => {
    const task = makeTask({ recurrence: 'FREQ=DAILY', due_date: '2026-07-01' });
    const result = applyComplete(task, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.wasRecurring).toBe(true);
  });

  test('reports wasRecurring=false for one-shot task', () => {
    const task = makeTask({ recurrence: null });
    const result = applyComplete(task, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.wasRecurring).toBe(false);
  });

  test('clears focused_until so done row passes IDB cross-field check', () => {
    const task = makeTask({ focused_until: '2026-07-01T12:00:00.000Z' });
    const result = applyComplete(task, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.task.focused_until).toBeNull();
    expect(result.value.task.status).toBe('done');
  });

  test('clears defer fields so done row passes IDB cross-field check', () => {
    const task = makeTask({ defer_kind: 'someday' });
    const result = applyComplete(task, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.task.defer_kind).toBe('none');
    expect(result.value.task.defer_until).toBeNull();
    expect(result.value.task.status).toBe('done');
  });

  test('already_done on done task', () => {
    const task = makeTask({ status: 'done' });
    const result = applyComplete(task, NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('already_done');
  });
});

// ─── applyDefer ───────────────────────────────────────────────────────────────

describe('applyDefer', () => {
  test('kind=someday: sets defer_kind=someday, nulls defer_until, clears focus', () => {
    const task = makeTask({ focused_until: '2026-06-18T15:00:00.000Z' });
    const result = applyDefer(task, { kind: 'someday' }, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { task: updated, body } = result.value;
    expect(updated.defer_kind).toBe('someday');
    expect(updated.defer_until).toBeNull();
    expect(updated.focused_until).toBeNull();
    expect(body.defer_kind).toBe('someday');
    expect(body.defer_until).toBeNull();
    expect(body.focused_until).toBeNull();
  });

  test('kind=until: sets both defer fields and clears focus', () => {
    const task = makeTask({ focused_until: LATER });
    const result = applyDefer(task, { kind: 'until', until: LATER }, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { task: updated } = result.value;
    expect(updated.defer_kind).toBe('until');
    expect(updated.defer_until).toBe(LATER);
    expect(updated.focused_until).toBeNull();
  });

  test('not_pending on done task', () => {
    const task = makeTask({ status: 'done' });
    const result = applyDefer(task, { kind: 'someday' }, NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('not_pending');
  });
});

// ─── applyClearDefer ──────────────────────────────────────────────────────────

describe('applyClearDefer', () => {
  test('resets defer to none and nulls defer_until', () => {
    const task = makeTask({ defer_kind: 'someday', defer_until: null });
    const result = applyClearDefer(task, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.task.defer_kind).toBe('none');
    expect(result.value.task.defer_until).toBeNull();
    expect(result.value.body.defer_kind).toBe('none');
    expect(result.value.body.defer_until).toBeNull();
  });

  test('not_pending on done task', () => {
    const task = makeTask({ status: 'done' });
    const result = applyClearDefer(task, NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('not_pending');
  });
});

// ─── applyFocus ───────────────────────────────────────────────────────────────

describe('applyFocus', () => {
  test('sets focused_until to now + hours', () => {
    const task = makeTask();
    const result = applyFocus(task, 3, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const expected = new Date(Date.parse(NOW) + 3 * 3_600_000).toISOString();
    expect(result.value.task.focused_until).toBe(expected);
    expect(result.value.body.focused_until).toBe(expected);
  });

  test('not_pending on done task', () => {
    const task = makeTask({ status: 'done' });
    const result = applyFocus(task, 3, NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('not_pending');
  });

  test.each([
    ['NaN', NaN],
    ['0', 0],
    ['negative', -1],
    ['Infinity', Infinity],
    ['25 (> max)', 25],
  ])('invalid hours: %s → invalid_hours', (_, hours) => {
    const task = makeTask();
    const result = applyFocus(task, hours, NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid_hours');
  });

  test.each([1, 3, 12, 24])('valid hours: %i → ok', (hours) => {
    const task = makeTask();
    const result = applyFocus(task, hours, NOW);
    expect(result.ok).toBe(true);
  });

  test('focusing a deferred task clears defer state (mirrors worker focusTaskPlan)', () => {
    const task = makeTask({ defer_kind: 'someday', defer_until: null });
    const result = applyFocus(task, 3, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { task: updated, body } = result.value;
    expect(updated.defer_kind).toBe('none');
    expect(updated.defer_until).toBeNull();
    expect(body.defer_kind).toBe('none');
    expect(body.defer_until).toBeNull();
    expect(updated.focused_until).not.toBeNull();
  });
});

// ─── applyUnfocus ─────────────────────────────────────────────────────────────

describe('applyUnfocus', () => {
  test('clears focused_until', () => {
    const task = makeTask({ focused_until: LATER });
    const result = applyUnfocus(task, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.task.focused_until).toBeNull();
    expect(result.value.body.focused_until).toBeNull();
  });

  test('succeeds even when already unfocused', () => {
    const task = makeTask({ focused_until: null });
    const result = applyUnfocus(task, NOW);
    expect(result.ok).toBe(true);
  });
});

// ─── applyReopen ──────────────────────────────────────────────────────────────

describe('applyReopen', () => {
  test('marks done task pending and clears defer/focus', () => {
    const task = makeTask({ status: 'done', defer_kind: 'none', defer_until: null, focused_until: null });
    const result = applyReopen(task, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { task: updated, body } = result.value;
    expect(updated.status).toBe('pending');
    expect(updated.defer_kind).toBe('none');
    expect(updated.defer_until).toBeNull();
    expect(updated.focused_until).toBeNull();
    expect(body.status).toBe('pending');
    expect(updated.updated_at).toBe(NOW);
  });

  test('clears defer on a someday-deferred pending task (mirrors worker reopenTaskPlan)', () => {
    const task = makeTask({ status: 'pending', defer_kind: 'someday', defer_until: null });
    const result = applyReopen(task, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.task.defer_kind).toBe('none');
    expect(result.value.task.defer_until).toBeNull();
    expect(result.value.task.status).toBe('pending');
  });

  test('clears defer on an until-deferred pending task', () => {
    const task = makeTask({ status: 'pending', defer_kind: 'until', defer_until: LATER });
    const result = applyReopen(task, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.task.defer_kind).toBe('none');
    expect(result.value.task.defer_until).toBeNull();
  });

  test('not_reopenable on a non-deferred pending task', () => {
    const task = makeTask({ status: 'pending', defer_kind: 'none' });
    const result = applyReopen(task, NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('not_reopenable');
  });
});
