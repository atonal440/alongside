import { describe, expect, it } from 'vitest';
import type { Task, TaskUpdate } from '@shared/types';
import type { Plan } from '../src/domain/Op';
import { DB, DomainOperationError } from '../src/db';

const TASK_EXISTS_GUARD_SQL =
  "INSERT INTO tasks (title,status,created_at,updated_at,defer_kind,task_type) SELECT NULL,'pending','','','none','action' WHERE NOT EXISTS (SELECT 1 FROM tasks WHERE id = ?)";

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

function d1WithExistingTasks(taskIds: string[], options: {
  blockLinks?: Array<[string, string]>;
  deleteTasksBeforeBatch?: string[];
} = {}): {
  d1: D1Database;
  batches: FakeStatement[][];
  executedStatements: FakeStatement[];
} {
  const tasks = new Set(taskIds);
  const blockLinks = options.blockLinks ?? [];
  const batches: FakeStatement[][] = [];
  const executedStatements: FakeStatement[] = [];

  function hasBlocksPath(from: string, to: string): boolean {
    const seen = new Set<string>();
    const queue = [from];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || seen.has(current)) continue;
      if (current === to) return true;
      seen.add(current);
      for (const [source, target] of blockLinks) {
        if (source === current) queue.push(target);
      }
    }
    return false;
  }

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
          if (sql.includes('WITH RECURSIVE downstream')) {
            const from = String(statement.args[0]);
            const to = String(statement.args[1]);
            return (hasBlocksPath(from, to) ? { id: to } : null) as T | null;
          }

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
      for (const id of options.deleteTasksBeforeBatch ?? []) tasks.delete(id);

      for (const statement of statements) {
        if (statement.sql === TASK_EXISTS_GUARD_SQL) {
          const id = String(statement.args[0]);
          if (!tasks.has(id)) throw new Error('NOT NULL constraint failed: tasks.title');
          continue;
        }
        executedStatements.push(statement);
      }

      return statements.map(() => ({ success: true, meta: {} }) as D1Result);
    },
  } as unknown as D1Database;

  return { d1, batches, executedStatements };
}

function mutationSqls(statements: FakeStatement[]): string[] {
  return statements
    .map(statement => statement.sql)
    .filter(sql => sql !== TASK_EXISTS_GUARD_SQL);
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
    expect(mutationSqls(batches[0])).toEqual([
      'UPDATE tasks SET status = ?, updated_at = ?, defer_until = ?, defer_kind = ?, focused_until = ? WHERE id = ?',
      'INSERT INTO tasks (id,title,notes,status,due_date,recurrence,created_at,updated_at,defer_until,defer_kind,task_type,project_id,kickoff_note,session_log,focused_until) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ]);
  });

  it('completes a monthly positional BYDAY task through applyPlan', async () => {
    const task = taskRow({
      title: 'Publish meeting minutes',
      due_date: '2026-05-15',
      recurrence: 'FREQ=MONTHLY;BYDAY=3FR',
    });
    const { d1 } = d1WithExistingTasks([task.id]);
    const db = new DB(d1);
    db.getTask = async (id: string) => id === task.id ? task : null;

    const result = await db.completeTask(task.id);

    expect(result?.next).toMatchObject({
      title: 'Publish meeting minutes',
      due_date: '2026-06-19',
      recurrence: 'FREQ=MONTHLY;BYDAY=3FR',
      status: 'pending',
    });
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
    expect(mutationSqls(batches[0])).toEqual([
      'INSERT INTO projects (id,title,notes,kickoff_note,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
      'UPDATE tasks SET updated_at = ?, project_id = ? WHERE id = ?',
      'UPDATE tasks SET updated_at = ?, project_id = ? WHERE id = ?',
    ]);
    const updateStatements = batches[0].filter(statement => statement.sql.startsWith('UPDATE tasks SET'));
    expect(updateStatements[0].args.slice(-2)).toEqual([project.id, 't_abc12']);
    expect(updateStatements[1].args.slice(-2)).toEqual([project.id, 't_other1']);
  });

  it('does not create a project when an assigned task is missing', async () => {
    const { d1, batches } = d1WithExistingTasks([]);
    const db = new DB(d1);

    await expect(db.createProject({ title: 'Launch' }, ['t_missing'])).rejects.toMatchObject({
      appError: { kind: 'not_found', entity: 'task', id: 't_missing' },
    });
    expect(batches).toHaveLength(0);
  });

  it('does not create a project when an assigned task disappears before the batch mutates', async () => {
    const { d1, batches, executedStatements } = d1WithExistingTasks(['t_abc12'], {
      deleteTasksBeforeBatch: ['t_abc12'],
    });
    const db = new DB(d1);

    await expect(db.createProject({ title: 'Launch' }, ['t_abc12'])).rejects.toMatchObject({
      appError: { kind: 'not_found', entity: 'task', id: 't_abc12' },
    });
    expect(batches).toHaveLength(1);
    expect(batches[0][0].sql).toBe(TASK_EXISTS_GUARD_SQL);
    expect(executedStatements).toHaveLength(0);
  });

  it('creates blocks links through applyPlan with endpoint and cycle prechecks', async () => {
    const { d1, batches } = d1WithExistingTasks(['t_from1', 't_to222']);
    const db = new DB(d1);

    await db.linkTasks('t_from1', 't_to222', 'blocks');

    expect(batches).toHaveLength(1);
    expect(mutationSqls(batches[0])).toEqual([
      'INSERT OR REPLACE INTO task_links (from_task_id,to_task_id,link_type) VALUES (?,?,?)',
    ]);
    expect(batches[0].at(-1)?.args).toEqual(['t_from1', 't_to222', 'blocks']);
  });

  it('rejects links when an endpoint task is missing', async () => {
    const { d1, batches } = d1WithExistingTasks(['t_from1']);
    const db = new DB(d1);

    await expect(db.linkTasks('t_from1', 't_to222', 'blocks')).rejects.toMatchObject({
      appError: { kind: 'not_found', entity: 'task', id: 't_to222' },
    });
    expect(batches).toHaveLength(0);
  });

  it('rejects blocks links that would introduce a dependency cycle', async () => {
    const { d1, batches } = d1WithExistingTasks(['t_from1', 't_to222', 't_mid33'], {
      blockLinks: [['t_to222', 't_mid33'], ['t_mid33', 't_from1']],
    });
    const db = new DB(d1);

    await expect(db.linkTasks('t_from1', 't_to222', 'blocks')).rejects.toMatchObject({
      appError: { kind: 'conflict' },
    });
    expect(batches).toHaveLength(0);
  });

  it('rejects self-links before storage', async () => {
    const { d1, batches } = d1WithExistingTasks(['t_same1']);
    const db = new DB(d1);

    await expect(db.linkTasks('t_same1', 't_same1', 'related')).rejects.toMatchObject({
      appError: { kind: 'validation' },
    });
    expect(batches).toHaveLength(0);
  });

  it('rejects single-task transition plans that target a different task', async () => {
    const task = taskRow();
    const { d1, batches } = d1WithExistingTasks([task.id, 't_other1']);
    const db = new DB(d1);
    const plan = {
      assertions: [{ kind: 'task.exists', id: 't_other1' }],
      ops: [{
        kind: 'task.update',
        id: 't_other1',
        patch: { focused_until: '2026-05-15T16:00:00.000Z', updated_at: '2026-05-15T13:00:00.000Z' },
      }],
    } as Plan;

    await expect((db as unknown as {
      applySingleTaskUpdate(original: Task, plan: Plan): Promise<Task>;
    }).applySingleTaskUpdate(task, plan)).rejects.toMatchObject({
      appError: { kind: 'invariant_violation' },
    });
    expect(batches).toHaveLength(0);
  });
});

describe('DB task lifecycle patch boundaries', () => {
  it('accepts monthly positional BYDAY recurrence updates before persistence', async () => {
    const { db, getStoredTask } = dbWithTask(taskRow({
      due_date: '2026-05-15',
    }));

    const result = await db.updateTask('t_abc12', {
      recurrence: 'FREQ=MONTHLY;BYDAY=3FR',
    });

    expect(result).toMatchObject({
      recurrence: 'FREQ=MONTHLY;BYDAY=3FR',
    });
    expect(getStoredTask()).toMatchObject({
      recurrence: 'FREQ=MONTHLY;BYDAY=3FR',
    });
  });

  it('rejects recurrence updates that cannot advance from the task due date', async () => {
    const { db } = dbWithTask(taskRow({
      due_date: '2025-01-01',
    }));

    await expect(db.updateTask('t_abc12', {
      recurrence: 'FREQ=YEARLY;INTERVAL=2;BYMONTH=2;BYMONTHDAY=29',
    })).rejects.toMatchObject({
      appError: { kind: 'validation' },
    });
  });

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
