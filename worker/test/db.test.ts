import { describe, expect, it } from 'vitest';
import type { Task, TaskUpdate } from '@shared/types';
import { DB, DomainOperationError } from '../src/db';

function dbWithoutStorage(): DB {
  return new DB({} as ConstructorParameters<typeof DB>[0]);
}

function taskRow(overrides: Partial<Task> = {}): Task {
  return {
    id: 't_abc12',
    title: 'Focused task',
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

function dbWithTask(initialTask: Task): { db: DB; getStoredTask: () => Task } {
  let storedTask = initialTask;
  const db = new DB({} as ConstructorParameters<typeof DB>[0]);
  db.getTask = async (id: string) => storedTask.id === id ? storedTask : null;

  (db as unknown as {
    drizzle: {
      update: () => {
        set: (patch: Partial<Task>) => {
          where: () => Promise<void>;
        };
      };
    };
  }).drizzle = {
    update: () => ({
      set: (patch: Partial<Task>) => {
        storedTask = { ...storedTask, ...patch };
        return { where: async () => undefined };
      },
    }),
  };

  return { db, getStoredTask: () => storedTask };
}

describe('DB task recurrence boundaries', () => {
  it('rejects malformed RRULEs before persistence', async () => {
    await expect(dbWithoutStorage().addTask({
      title: 'Bad repeat',
      due_date: '2026-05-15',
      recurrence: 'FREQ=WEEKL',
    })).rejects.toMatchObject({
      appError: { kind: 'validation' },
    });
  });

  it('rejects recurring tasks without a due date before persistence', async () => {
    await expect(dbWithoutStorage().addTask({
      title: 'Undated repeat',
      recurrence: 'FREQ=DAILY',
    })).rejects.toBeInstanceOf(DomainOperationError);
  });
});

describe('DB task lifecycle patch boundaries', () => {
  it.each([
    {
      label: 'someday deferral',
      updates: { defer_kind: 'someday' },
      expected: { defer_kind: 'someday', defer_until: null },
    },
    {
      label: 'timed deferral',
      updates: { defer_kind: 'until', defer_until: '2026-05-16T09:00:00.000Z' },
      expected: { defer_kind: 'until', defer_until: '2026-05-16T09:00:00.000Z' },
    },
  ] satisfies Array<{ label: string; updates: TaskUpdate; expected: Partial<Task> }>)(
    'clears focus when PATCH applies a $label without focused_until',
    async ({ updates, expected }) => {
      const { db, getStoredTask } = dbWithTask(taskRow({
        focused_until: '2026-05-15T16:00:00.000Z',
      }));

      const result = await db.updateTask('t_abc12', updates);

      expect(result).toMatchObject({
        ...expected,
        focused_until: null,
      });
      expect(getStoredTask()).toMatchObject({
        ...expected,
        focused_until: null,
      });
    },
  );
});
