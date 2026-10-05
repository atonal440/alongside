import { describe, expect, test } from 'vitest';
import { taskMetaString } from '../../src/components/task/TaskMeta';
import { datePointLabel } from '../../src/utils/design';
import { isReady } from '@shared/readiness';
import { makeTask } from '../helpers/fixtures';

const LA = 'America/Los_Angeles';
const date = (value: string, timezone = LA) => JSON.stringify({ kind: 'date', date: value, timezone });
const instant = (at: string, timezone = LA) => JSON.stringify({ kind: 'instant', at, timezone });
const NOW = '2026-10-05T12:00:00.000Z';

describe('datePointLabel', () => {
  test('shows a date as entered and an instant in its own zone', () => {
    expect(datePointLabel(date('2026-10-09'))).toBe('2026-10-09');
    expect(datePointLabel(instant('2026-10-10T00:30:00Z'))).toBe('2026-10-09 at 17:30');
  });
  test('shows nothing for text that is not a point', () => {
    expect(datePointLabel('nope')).toBe('');
  });
});

describe('task meta', () => {
  test('lists the hard deadline next to the target', () => {
    expect(taskMetaString(makeTask({ due_date: '2026-10-08T12:00:00Z', deadline: date('2026-10-09') }), NOW)).toBe('2026-10-08 · Deadline 2026-10-09');
  });
  test('flags a deadline that has passed unless the task is done', () => {
    const task = makeTask({ deadline: date('2026-10-04') });
    expect(taskMetaString(task, NOW)).toBe('Past deadline · 2026-10-04');
    expect(taskMetaString({ ...task, status: 'done' }, NOW)).toBe('Deadline 2026-10-04');
  });
  test('treats a date deadline as open until the end of its local day', () => {
    // 2026-10-05 18:00 UTC is still the 5th in Los Angeles.
    expect(taskMetaString(makeTask({ deadline: date('2026-10-05') }), '2026-10-05T18:00:00.000Z')).toBe('Deadline 2026-10-05');
  });
  test('says when a task starts, only while that is still ahead', () => {
    const task = makeTask({ available_from: date('2026-10-07') });
    expect(taskMetaString(task, NOW)).toBe('Starts 2026-10-07');
    expect(taskMetaString(task, '2026-10-07T20:00:00.000Z')).toBe('');
  });
});

describe('readiness', () => {
  test('a task is not ready before its available_from opens', () => {
    const task = makeTask({ available_from: date('2026-10-07') });
    expect(isReady(task, [], [task], NOW)).toBe(false);
    expect(isReady(task, [], [task], '2026-10-08T00:00:00.000Z')).toBe(true);
  });
});
