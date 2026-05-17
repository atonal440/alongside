import { describe, expect, it } from 'vitest';
import { unsafeBrand } from '@shared/brand';
import type { Result } from '@shared/result';
import type { Task } from '@shared/types';
import type { IsoDateTime, MintedTaskId } from '../../src/parse';
import { parseIsoDateTime } from '@shared/parse';
import type { AppError } from '../../src/domain/errors';
import {
  clearDeferTaskPlan,
  completeTaskPlan,
  deferTaskPlan,
  focusTaskPlan,
  reopenTaskPlan,
} from '../../src/domain/ops/task';
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

describe('task defer/focus lifecycle codec', () => {
  it('rejects defer_until when defer_kind is none', () => {
    const result = taskFromRow(taskRow({
      defer_kind: 'none',
      defer_until: '2026-05-16T09:00:00.000Z',
    }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContainEqual(expect.objectContaining({
        path: ['defer_until'],
        code: 'invalid_state',
      }));
    }
  });

  it('rejects defer_until when defer_kind is someday', () => {
    const result = taskFromRow(taskRow({
      defer_kind: 'someday',
      defer_until: '2026-05-16T09:00:00.000Z',
    }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContainEqual(expect.objectContaining({
        path: ['defer_until'],
        code: 'invalid_state',
      }));
    }
  });

  it('rejects until deferrals without a timestamp', () => {
    const result = taskFromRow(taskRow({ defer_kind: 'until', defer_until: null }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContainEqual(expect.objectContaining({
        path: ['defer_until'],
        code: 'required',
      }));
    }
  });

  it('rejects focused deferred tasks', () => {
    const result = taskFromRow(taskRow({
      defer_kind: 'someday',
      focused_until: '2026-05-16T09:00:00.000Z',
    }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContainEqual(expect.objectContaining({
        path: ['focused_until'],
        code: 'invalid_state',
      }));
    }
  });

  it('rejects done tasks with active focus or deferral fields', () => {
    const result = taskFromRow(taskRow({
      status: 'done',
      defer_kind: 'someday',
      focused_until: '2026-05-16T09:00:00.000Z',
    }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ['defer_kind'], code: 'invalid_state' }),
        expect.objectContaining({ path: ['focused_until'], code: 'invalid_state' }),
      ]));
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

describe('defer/focus lifecycle planners', () => {
  it('plans a timed deferral and clears focus atomically', () => {
    const task = expectOk(pendingTaskFromRow(taskRow({
      focused_until: '2026-05-15T16:00:00.000Z',
    })));
    const until = expectOk(parseIsoDateTime('2026-05-16T09:00:00.000Z'));
    const plan = expectOk(deferTaskPlan(task, {
      defer: { kind: 'until', until },
      updatedAt: timestamp(),
    }));

    expect(plan.ops).toEqual([{
      kind: 'task.update',
      id: 't_abc12',
      patch: {
        defer_kind: 'until',
        defer_until: '2026-05-16T09:00:00.000Z',
        focused_until: null,
        updated_at: '2026-05-15T13:00:00.000Z',
      },
    }]);
  });

  it('plans clearing a deferral without touching focus', () => {
    const task = expectOk(pendingTaskFromRow(taskRow({ defer_kind: 'someday' })));
    const plan = expectOk(clearDeferTaskPlan(task, { updatedAt: timestamp() }));

    expect(plan.ops).toEqual([{
      kind: 'task.update',
      id: 't_abc12',
      patch: {
        defer_kind: 'none',
        defer_until: null,
        updated_at: '2026-05-15T13:00:00.000Z',
      },
    }]);
  });

  it('plans focus for an active pending task', () => {
    const task = expectOk(pendingTaskFromRow(taskRow()));
    const focusedUntil = expectOk(parseIsoDateTime('2026-05-15T16:00:00.000Z'));
    const plan = expectOk(focusTaskPlan(task, {
      focus: { kind: 'focused', until: focusedUntil },
      updatedAt: timestamp(),
    }));

    expect(plan.ops).toEqual([{
      kind: 'task.update',
      id: 't_abc12',
      patch: {
        focused_until: '2026-05-15T16:00:00.000Z',
        updated_at: '2026-05-15T13:00:00.000Z',
      },
    }]);
  });

  it('plans focus for a someday task by clearing the deferral', () => {
    const task = expectOk(pendingTaskFromRow(taskRow({ defer_kind: 'someday' })));
    const focusedUntil = expectOk(parseIsoDateTime('2026-05-15T16:00:00.000Z'));
    const plan = expectOk(focusTaskPlan(task, {
      focus: { kind: 'focused', until: focusedUntil },
      updatedAt: timestamp(),
    }));

    expect(plan.ops).toEqual([{
      kind: 'task.update',
      id: 't_abc12',
      patch: {
        defer_kind: 'none',
        defer_until: null,
        focused_until: '2026-05-15T16:00:00.000Z',
        updated_at: '2026-05-15T13:00:00.000Z',
      },
    }]);
  });

  it('plans focus for an elapsed timed deferral by clearing the stale deferral', () => {
    const task = expectOk(pendingTaskFromRow(taskRow({
      defer_kind: 'until',
      defer_until: '2026-05-15T12:00:00.000Z',
    })));
    const focusedUntil = expectOk(parseIsoDateTime('2026-05-15T16:00:00.000Z'));
    const plan = expectOk(focusTaskPlan(task, {
      focus: { kind: 'focused', until: focusedUntil },
      updatedAt: timestamp(),
    }));

    expect(plan.ops).toEqual([{
      kind: 'task.update',
      id: 't_abc12',
      patch: {
        defer_kind: 'none',
        defer_until: null,
        focused_until: '2026-05-15T16:00:00.000Z',
        updated_at: '2026-05-15T13:00:00.000Z',
      },
    }]);
  });

  it('plans focus for a future timed deferral by clearing the deferral', () => {
    const task = expectOk(pendingTaskFromRow(taskRow({
      defer_kind: 'until',
      defer_until: '2026-05-15T14:00:00.000Z',
    })));
    const focusedUntil = expectOk(parseIsoDateTime('2026-05-15T16:00:00.000Z'));
    const plan = expectOk(focusTaskPlan(task, {
      focus: { kind: 'focused', until: focusedUntil },
      updatedAt: timestamp(),
    }));

    expect(plan.ops).toEqual([{
      kind: 'task.update',
      id: 't_abc12',
      patch: {
        defer_kind: 'none',
        defer_until: null,
        focused_until: '2026-05-15T16:00:00.000Z',
        updated_at: '2026-05-15T13:00:00.000Z',
      },
    }]);
  });

  it('plans reopening a done task as pending and active', () => {
    const task = expectOk(taskFromRow(taskRow({ status: 'done' })));
    if (task.lifecycle !== 'done') throw new Error('Expected done task.');

    const plan = expectOk(reopenTaskPlan(task, { updatedAt: timestamp() }));

    expect(plan.ops).toEqual([{
      kind: 'task.update',
      id: 't_abc12',
      patch: {
        status: 'pending',
        defer_kind: 'none',
        defer_until: null,
        focused_until: null,
        updated_at: '2026-05-15T13:00:00.000Z',
      },
    }]);
  });

  it('plans reopening a deferred pending task as active', () => {
    const task = expectOk(pendingTaskFromRow(taskRow({ defer_kind: 'someday' })));
    const plan = expectOk(reopenTaskPlan(task, { updatedAt: timestamp() }));

    expect(plan.ops).toEqual([{
      kind: 'task.update',
      id: 't_abc12',
      patch: {
        status: 'pending',
        defer_kind: 'none',
        defer_until: null,
        focused_until: null,
        updated_at: '2026-05-15T13:00:00.000Z',
      },
    }]);
  });
});
