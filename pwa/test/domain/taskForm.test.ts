import { describe, test, expect } from 'vitest';
import { parseTaskForm, parseQuickAddTitle } from '../../src/domain/taskForm';
import type { TaskFormInput } from '../../src/domain/taskForm';

function baseInput(overrides: Partial<TaskFormInput> = {}): TaskFormInput {
  return {
    title: 'Buy milk',
    notes: '',
    kickoffNote: '',
    dueDate: '',
    recurrence: '',
    sessionLog: '',
    deferKind: 'none',
    deferUntil: '',
    ...overrides,
  };
}

// ─── parseTaskForm ────────────────────────────────────────────────────────────

describe('parseTaskForm — title', () => {
  test('valid title returns ok preserving original value (no trim)', () => {
    const result = parseTaskForm(baseInput({ title: '  Buy milk  ' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Edit-form titles are NOT trimmed so round-trips don't silently rewrite stored whitespace.
    expect(result.value.title).toBe('  Buy milk  ');
  });

  test('empty string → error on title', () => {
    const result = parseTaskForm(baseInput({ title: '' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.title).toBeDefined();
  });

  test('whitespace-only → error on title', () => {
    const result = parseTaskForm(baseInput({ title: '   ' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.title).toBeDefined();
  });

  test('exactly 200 chars → ok', () => {
    const result = parseTaskForm(baseInput({ title: 'a'.repeat(200) }));
    expect(result.ok).toBe(true);
  });

  test('201 chars → error on title', () => {
    const result = parseTaskForm(baseInput({ title: 'a'.repeat(201) }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.title).toBeDefined();
  });
});

describe('parseTaskForm — notes', () => {
  test('empty string → null in patch', () => {
    const result = parseTaskForm(baseInput({ notes: '' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.notes).toBeNull();
  });

  test('non-empty notes → included in patch', () => {
    const result = parseTaskForm(baseInput({ notes: 'Some notes' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.notes).toBe('Some notes');
  });

  test('over 10 000 chars → error on notes', () => {
    const result = parseTaskForm(baseInput({ notes: 'a'.repeat(10_001) }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.notes).toBeDefined();
  });
});

describe('parseTaskForm — kickoffNote', () => {
  test('empty → null', () => {
    const result = parseTaskForm(baseInput({ kickoffNote: '' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.kickoff_note).toBeNull();
  });

  test('over 2 000 chars → error', () => {
    const result = parseTaskForm(baseInput({ kickoffNote: 'a'.repeat(2_001) }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kickoffNote).toBeDefined();
  });
});

describe('parseTaskForm — sessionLog', () => {
  test('empty → null', () => {
    const result = parseTaskForm(baseInput({ sessionLog: '' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.session_log).toBeNull();
  });

  test('over 10 000 chars → error', () => {
    const result = parseTaskForm(baseInput({ sessionLog: 'a'.repeat(10_001) }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.sessionLog).toBeDefined();
  });
});

describe('parseTaskForm — dueDate', () => {
  test('empty → null due_date', () => {
    const result = parseTaskForm(baseInput({ dueDate: '' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.due_date).toBeNull();
  });

  test('valid ISO date → IsoDate in patch', () => {
    const result = parseTaskForm(baseInput({ dueDate: '2026-07-01' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.due_date).toBe('2026-07-01');
  });

  test('invalid date string → error on dueDate', () => {
    const result = parseTaskForm(baseInput({ dueDate: 'not-a-date' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.dueDate).toBeDefined();
  });

  test('impossible date (Feb 30) → error on dueDate', () => {
    const result = parseTaskForm(baseInput({ dueDate: '2026-02-30' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.dueDate).toBeDefined();
  });
});

describe('parseTaskForm — recurrence', () => {
  test('empty → null recurrence', () => {
    const result = parseTaskForm(baseInput({ recurrence: '' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.recurrence).toBeNull();
  });

  test('valid RRULE with due date → included in patch', () => {
    const result = parseTaskForm(baseInput({ recurrence: 'FREQ=WEEKLY;INTERVAL=1', dueDate: '2026-07-01' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.recurrence).toBe('FREQ=WEEKLY;INTERVAL=1');
  });

  test('invalid RRULE → error on recurrence', () => {
    const result = parseTaskForm(baseInput({ recurrence: 'FREQ=WEEKL', dueDate: '2026-07-01' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.recurrence).toBeDefined();
  });

  test('cross-field: recurrence without due date → error on recurrence', () => {
    const result = parseTaskForm(baseInput({ recurrence: 'FREQ=DAILY;INTERVAL=1', dueDate: '' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.recurrence).toMatch(/due date/i);
  });

  test('cross-field: recurrence with valid due date → ok', () => {
    const result = parseTaskForm(baseInput({
      recurrence: 'FREQ=DAILY;INTERVAL=1',
      dueDate: '2026-07-04',
    }));
    expect(result.ok).toBe(true);
  });
});

describe('parseTaskForm — defer', () => {
  test('deferKind=none → defer_until null in patch', () => {
    const result = parseTaskForm(baseInput({ deferKind: 'none', deferUntil: '' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.defer_kind).toBe('none');
    expect(result.value.defer_until).toBeNull();
  });

  test('deferKind=someday → defer_until null, focused_until null in patch', () => {
    const result = parseTaskForm(baseInput({ deferKind: 'someday' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.defer_kind).toBe('someday');
    expect(result.value.defer_until).toBeNull();
    expect(result.value.focused_until).toBeNull();
  });

  test('deferKind=until with date → defer_until at 9am ISO in patch', () => {
    const result = parseTaskForm(baseInput({ deferKind: 'until', deferUntil: '2026-07-10' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.defer_kind).toBe('until');
    expect(result.value.defer_until).toBeTruthy();
    expect(result.value.defer_until).toContain('2026-07-10');
  });

  test('deferKind=until with unchanged date preserves original timestamp', () => {
    const original = '2026-07-10T17:00:00.000Z';
    const result = parseTaskForm(baseInput({
      deferKind: 'until',
      deferUntil: '2026-07-10',
      existingDeferUntil: original,
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.defer_until).toBe(original);
  });

  test('deferKind=until with changed date normalizes to 9am', () => {
    const original = '2026-07-10T17:00:00.000Z';
    const result = parseTaskForm(baseInput({
      deferKind: 'until',
      deferUntil: '2026-07-15', // different date
      existingDeferUntil: original,
    }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.defer_until).toContain('2026-07-15');
    expect(result.value.defer_until).not.toBe(original);
  });

  test('deferKind=until with no date → error on deferUntil', () => {
    const result = parseTaskForm(baseInput({ deferKind: 'until', deferUntil: '' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.deferUntil).toBeDefined();
  });
});

describe('parseTaskForm — multiple errors', () => {
  test('title + recurrence errors both reported', () => {
    const result = parseTaskForm(baseInput({ title: '', recurrence: 'FREQ=WEEKL' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.title).toBeDefined();
    expect(result.error.recurrence).toBeDefined();
  });
});

// ─── parseQuickAddTitle ───────────────────────────────────────────────────────

describe('parseQuickAddTitle', () => {
  test('valid title → ok with trimmed NonEmptyString<200>', () => {
    const result = parseQuickAddTitle('  Buy eggs  ');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe('Buy eggs');
  });

  test('empty string → error string', () => {
    const result = parseQuickAddTitle('');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(typeof result.error).toBe('string');
    expect(result.error.length).toBeGreaterThan(0);
  });

  test('whitespace-only → error', () => {
    const result = parseQuickAddTitle('   ');
    expect(result.ok).toBe(false);
  });

  test('exactly 200 chars → ok', () => {
    const result = parseQuickAddTitle('a'.repeat(200));
    expect(result.ok).toBe(true);
  });

  test('201 chars → error', () => {
    const result = parseQuickAddTitle('a'.repeat(201));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(typeof result.error).toBe('string');
  });
});
