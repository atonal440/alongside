import { describe, test, expect } from 'vitest';
import { parseTaskRow, parseProjectRow, parseTaskLinkRow } from '@shared/wire/rows';
import { makeTask, makeProject, makeLink } from '../helpers/fixtures';

// Helper: assert a parse result is ok
function assertOk<T, E>(result: { ok: true; value: T } | { ok: false; error: E }): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('Expected ok result');
  return result.value;
}

describe('parseTaskRow', () => {
  test('accepts a valid task fixture', () => {
    const result = parseTaskRow(makeTask());
    assertOk(result);
  });

  test('rejects a bad id format', () => {
    const result = parseTaskRow(makeTask({ id: 'task_123' }));
    expect(result.ok).toBe(false);
  });

  test('rejects unknown status', () => {
    const result = parseTaskRow(makeTask({ status: 'active' as never }));
    expect(result.ok).toBe(false);
  });

  test('rejects malformed updated_at', () => {
    const result = parseTaskRow(makeTask({ updated_at: '2026-06-09' }));
    expect(result.ok).toBe(false);
  });

  test('rejects overlong title', () => {
    const result = parseTaskRow(makeTask({ title: 'x'.repeat(201) }));
    expect(result.ok).toBe(false);
  });

  test('rejects empty title', () => {
    const result = parseTaskRow(makeTask({ title: '   ' }));
    expect(result.ok).toBe(false);
  });

  test('rejects invalid RRULE string in recurrence', () => {
    const result = parseTaskRow(makeTask({ recurrence: 'NOT_AN_RRULE' }));
    expect(result.ok).toBe(false);
  });

  test('rejects malformed defer_until', () => {
    const result = parseTaskRow(makeTask({ defer_until: 'tomorrow' as never }));
    expect(result.ok).toBe(false);
  });

  test('rejects missing defer_kind (required in canonical shape)', () => {
    const { defer_kind: _, ...withoutDeferKind } = makeTask();
    const result = parseTaskRow(withoutDeferKind);
    expect(result.ok).toBe(false);
  });

  test('accepts valid recurrence string', () => {
    const result = parseTaskRow(makeTask({ due_date: '2026-07-01', recurrence: 'FREQ=WEEKLY' }));
    assertOk(result);
  });

  test('accepts defer_kind=until with valid defer_until', () => {
    const result = parseTaskRow(
      makeTask({ defer_kind: 'until', defer_until: '2026-12-01T09:00:00.000Z' }),
    );
    assertOk(result);
  });
});

describe('parseProjectRow', () => {
  test('accepts a valid project fixture', () => {
    const result = parseProjectRow(makeProject());
    assertOk(result);
  });

  test('rejects bad project id format', () => {
    const result = parseProjectRow(makeProject({ id: 'project_123' }));
    expect(result.ok).toBe(false);
  });
});

describe('parseTaskLinkRow', () => {
  test('accepts a valid link fixture', () => {
    const result = parseTaskLinkRow(makeLink());
    assertOk(result);
  });

  test('rejects unknown link type', () => {
    const result = parseTaskLinkRow(makeLink({ link_type: 'depends_on' as never }));
    expect(result.ok).toBe(false);
  });
});
