import { describe, expect, it } from 'vitest';
import { unsafeBrand } from '@shared/brand';
import type { Result } from '@shared/result';
import type { Task } from '@shared/types';
import type { IsoDateTime, MintedTaskId } from '../../src/parse';
import { parseIsoDateTime } from '@shared/parse';
import type { AppError } from '../../src/domain/errors';
import { completeTaskPlan } from '../../src/domain/ops/task';
import { pendingTaskFromRow, recurrenceFromRow, taskFromRow } from '../../src/domain/task';

function expectOk<T, E>(result: Result<T, E>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('Expected ok result.');
  return result.value;
}

function taskRow(overrides: Partial<Task> = {}): Task {
  return {
    id: 't_abc12',
    title: 'Water the tomatoes',
    notes: null,
    status: 'pending',
    due_date: null,
    recurrence: null,
    created_at: '2026-05-15T12:00:00.000Z',
    updated_at: '2026-05-15T12:00:00.000Z',
    defer_until: null,
    defer_kind: 'none',
    task_type: 'action',
    project_id: null,
    kickoff_note: null,
    session_log: null,
    focused_until: null,
    ...overrides,
  };
}

function timestamp(): IsoDateTime {
  return expectOk(parseIsoDateTime('2026-05-15T13:00:00.000Z'));
}

function nextTaskId(): MintedTaskId {
  return unsafeBrand<string, 'MintedTaskId'>('t_next1') as MintedTaskId;
}

describe('task recurrence domain codec', () => {
  it('converts recurrence-bearing rows into a parsed recurrence domain value', () => {
    const task = expectOk(taskFromRow(taskRow({
      due_date: '2026-05-15',
      recurrence: 'FREQ=WEEKLY;INTERVAL=2',
    })));

    expect(task.recurrence).toMatchObject({
      kind: 'recurring',
      firstDue: '2026-05-15',
      rrule: 'FREQ=WEEKLY;INTERVAL=2',
    });
  });

  it('rejects recurrence without a due date', () => {
    const result = recurrenceFromRow(null, 'FREQ=DAILY');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContainEqual(expect.objectContaining({
        path: ['due_date'],
        code: 'required',
      }));
    }
  });

  it('rejects malformed recurrence strings before they reach storage', () => {
    const result = recurrenceFromRow('2026-05-15', 'FREQ=WEEKL');

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContainEqual(expect.objectContaining({
        path: ['recurrence'],
      }));
    }
  });
});

describe('completeTaskPlan', () => {
  it('plans a one-shot completion as a single task update', () => {
    const task = expectOk(pendingTaskFromRow(taskRow()));
    const plan = expectOk(completeTaskPlan(task, { completedAt: timestamp() }));

    expect(plan.ops).toEqual([{
      kind: 'task.update',
      id: 't_abc12',
      patch: {
        status: 'done',
        defer_kind: 'none',
        defer_until: null,
        focused_until: null,
        updated_at: '2026-05-15T13:00:00.000Z',
      },
    }]);
  });

  it('plans recurring completion with a next occurrence row', () => {
    const task = expectOk(pendingTaskFromRow(taskRow({
      due_date: '2026-05-15',
      recurrence: 'FREQ=WEEKLY;INTERVAL=2',
      kickoff_note: 'Start by checking soil moisture.',
      session_log: 'Finished the deep watering pass.',
    })));
    const plan = expectOk(completeTaskPlan(task, {
      completedAt: timestamp(),
      nextTaskId: nextTaskId(),
    }));

    expect(plan.ops).toHaveLength(2);
    expect(plan.ops[1]).toEqual({
      kind: 'task.insert',
      row: {
        id: 't_next1',
        title: 'Water the tomatoes',
        notes: null,
        status: 'pending',
        due_date: '2026-05-29',
        recurrence: 'FREQ=WEEKLY;INTERVAL=2',
        created_at: '2026-05-15T13:00:00.000Z',
        updated_at: '2026-05-15T13:00:00.000Z',
        defer_until: null,
        defer_kind: 'none',
        task_type: 'action',
        project_id: null,
        kickoff_note: 'Finished the deep watering pass.',
        session_log: null,
        focused_until: null,
      },
    });
  });

  it('rejects completing a done task at the lifecycle boundary', () => {
    const result = pendingTaskFromRow(taskRow({ status: 'done' }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect((result.error as AppError).kind).toBe('invalid_transition');
    }
  });
});
