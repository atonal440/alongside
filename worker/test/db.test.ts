import { describe, expect, it } from 'vitest';
import type { Task, TaskUpdate } from '@shared/types';
import { DB, DomainOperationError } from '../src/db';

function dbWithoutStorage(): DB {
  return new DB({} as ConstructorParameters<typeof DB>[0]);
}

interface FakeStatement {
  sql: string;
  args: unknown[];
  bind(...args: unknown[]): FakeStatement;
  first<T>(): Promise<T | null>;
  run(): Promise<D1Result>;
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

function d1WithExistingTasks(taskIds: string[]): {
  d1: D1Database;
  batches: FakeStatement[][];
} {
  const tasks = new Set(taskIds);
  const batches: FakeStatement[][] = [];

  const d1 = {
    prepare(sql: string): FakeStatement {
      const statement: FakeStatement = {
        sql,
        args: [],
        bind(...args: unknown[]) {
          statement.args = args;
          return statement;
        },
        async first<T>() {
          const id = String(statement.args[0]);
          if (sql.includes('FROM tasks')) return (tasks.has(id) ? { id } : null) as T | null;
          return null;
        },
        async run() {
          return { success: true, meta: {} } as D1Result;
        },
      };
      return statement;
    },
    async batch(statements: FakeStatement[]) {
      batches.push(statements);
      return statements.map(() => ({ success: true, meta: {} }) as D1Result);
    },
  } as unknown as D1Database;

  return { d1, batches };
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

describe('DB plan application paths', () => {
  it('completes a recurring task through applyPlan and returns the completed and next rows', async () => {
    const task = taskRow({
      due_date: '2026-05-15',
      recurrence: 'FREQ=WEEKLY',
      kickoff_note: 'Start here',
      session_log: 'Finished this round',
    });
    const { d1, batches } = d1WithExistingTasks([task.id]);
    const db = new DB(d1);
    db.getTask = async (id: string) => id === task.id ? task : null;

    const result = await db.completeTask(task.id);

    expect(result?.completed).toMatchObject({ id: task.id, status: 'done' });
    expect(result?.next).toMatchObject({
      title: task.title,
      due_date: '2026-05-22',
      recurrence: 'FREQ=WEEKLY',
      kickoff_note: 'Finished this round',
      status: 'pending',
    });
    expect(batches).toHaveLength(1);
    expect(batches[0].map(statement => statement.sql)).toEqual([
      'UPDATE tasks SET status = ?, updated_at = ?, defer_until = ?, defer_kind = ?, focused_until = ? WHERE id = ?',
      'INSERT INTO tasks (id,title,notes,status,due_date,recurrence,created_at,updated_at,defer_until,defer_kind,task_type,project_id,kickoff_note,session_log,focused_until) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ]);
  });

  it('creates a project and assigns unique existing tasks in one plan batch', async () => {
    const { d1, batches } = d1WithExistingTasks(['t_abc12', 't_other1']);
    const db = new DB(d1);

    const project = await db.createProject(
      { title: 'Launch', notes: 'Project notes' },
      ['t_abc12', 't_abc12', 't_other1'],
    );

    expect(project.id).toMatch(/^p_[0-9A-Za-z_-]{5,}$/);
    expect(batches).toHaveLength(1);
    expect(batches[0].map(statement => statement.sql)).toEqual([
      'INSERT INTO projects (id,title,notes,kickoff_note,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
      'UPDATE tasks SET updated_at = ?, project_id = ? WHERE id = ?',
      'UPDATE tasks SET updated_at = ?, project_id = ? WHERE id = ?',
    ]);
    expect(batches[0][1].args.slice(-2)).toEqual([project.id, 't_abc12']);
    expect(batches[0][2].args.slice(-2)).toEqual([project.id, 't_other1']);
  });

  it('does not create a project when an assigned task is missing', async () => {
    const { d1, batches } = d1WithExistingTasks([]);
    const db = new DB(d1);

    await expect(db.createProject({ title: 'Launch' }, ['t_missing'])).rejects.toMatchObject({
      appError: { kind: 'not_found', entity: 'task', id: 't_missing' },
    });
    expect(batches).toHaveLength(0);
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
