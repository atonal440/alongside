import { describe, expect, it } from 'vitest';
import type { Project, Task, TaskUpdate } from '@shared/types';
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
    due_all_day: null,
    duty_id: null,
    occurrence_at: null,
    available_from: null,
    deadline: null,
    parent_id: null,
    position: null,
    ...overrides,
  };
}

function projectRow(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p_abc12',
    title: 'Launch',
    notes: null,
    kickoff_note: null,
    status: 'active',
    created_at: '2026-05-15T12:00:00.000Z',
    updated_at: '2026-05-15T12:00:00.000Z',
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

function dbWithProject(initialProject: Project): { db: DB; getStoredProject: () => Project } {
  let storedProject = initialProject;
  const db = new DB({} as ConstructorParameters<typeof DB>[0]);
  db.getProject = async (id: string) => storedProject.id === id ? storedProject : null;

  (db as unknown as {
    drizzle: {
      update: () => {
        set: (patch: Partial<Project>) => {
          where: () => Promise<void>;
        };
      };
    };
  }).drizzle = {
    update: () => ({
      set: (patch: Partial<Project>) => {
        storedProject = { ...storedProject, ...patch };
        return { where: async () => undefined };
      },
    }),
  };

  return { db, getStoredProject: () => storedProject };
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
  const blockLinks = [...(options.blockLinks ?? [])];
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

          if (sql.includes('AS violated')) return null;   // hierarchy guards: no subtasks
          const id = String(statement.args[0]);
          if (sql.includes('FROM tasks')) return (tasks.has(id) ? { id } : null) as T | null;
          return null;
        },
        async all() {
          return { success: true, results: [] };   // no subtasks
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
        if (statement.sql.includes("SELECT NULL,NULL,'blocks'")) {
          const [from, to, pathFrom, pathTo] = statement.args.map(String);
          if (from === to || hasBlocksPath(pathFrom, pathTo)) {
            throw new Error('NOT NULL constraint failed: task_links.from_task_id');
          }
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
    .filter(sql => sql !== TASK_EXISTS_GUARD_SQL && !sql.includes("SELECT NULL,NULL,'blocks'") && !sql.startsWith("INSERT INTO entity_versions(entity,entity_key,revision) SELECT NULL,'',0 WHERE"));
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

  // Codex-flagged (PR #40): the legacy RRULE math is date-only and would
  // silently discard a real time-of-day when spawning the next occurrence.
  it('rejects recurring tasks with a genuinely timed due_date before persistence', async () => {
    await expect(dbWithoutStorage().addTask({
      title: 'Timed repeat',
      due_date: '2026-07-01T09:30:00Z',
      recurrence: 'FREQ=WEEKLY',
    })).rejects.toMatchObject({
      appError: { kind: 'validation' },
    });
  });
});

describe('DB project and preference write boundaries', () => {
  it('rejects project titles that export/import would reject', async () => {
    await expect(dbWithoutStorage().createProject({ title: '' })).rejects.toMatchObject({
      appError: { kind: 'validation' },
    });
  });

  it('rejects project updates that would create non-restorable rows', async () => {
    const { db, getStoredProject } = dbWithProject(projectRow());

    await expect(db.updateProject('p_abc12', {
      title: 'x'.repeat(201),
    })).rejects.toMatchObject({
      appError: { kind: 'validation' },
    });
    expect(getStoredProject().title).toBe('Launch');
  });

  it('rejects preference values that export/import would reject', async () => {
    await expect(dbWithoutStorage().setPreference('sort_by', 'alphabetical')).rejects.toMatchObject({
      appError: { kind: 'validation' },
    });
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
      due_date: '2026-05-22T12:00:00Z',
      recurrence: 'FREQ=WEEKLY',
      kickoff_note: 'Finished this round',
      status: 'pending',
    });
    expect(batches).toHaveLength(1);
    expect(mutationSqls(batches[0])).toEqual([
      'UPDATE tasks SET status = ?, updated_at = ?, defer_until = ?, defer_kind = ?, focused_until = ? WHERE id = ?',
      'INSERT INTO tasks (id,title,notes,status,due_date,due_all_day,recurrence,created_at,updated_at,defer_until,defer_kind,task_type,project_id,kickoff_note,session_log,focused_until,duty_id,occurrence_at,available_from,deadline,parent_id,position) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
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
      due_date: '2026-06-19T12:00:00Z',
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

  // due_all_day resolution (codex-flagged follow-up to Stage 1,
  // docs/plans/duties-implementation-todo.md "Notes / deviations"):
  // db.updateTask/addTask is the single choke point both REST and MCP funnel
  // through, so its derive-vs-override behavior is worth covering directly.
  it('derives due_all_day from a bare date when not supplied', async () => {
    const { db, getStoredTask } = dbWithTask(taskRow());

    await db.updateTask('t_abc12', { due_date: '2026-06-01' });

    expect(getStoredTask()).toMatchObject({
      due_date: '2026-06-01T12:00:00Z',
      due_all_day: true,
    });
  });

  it('derives due_all_day: false from a full datetime when not supplied', async () => {
    const { db, getStoredTask } = dbWithTask(taskRow());

    await db.updateTask('t_abc12', { due_date: '2026-06-01T09:30:00Z' });

    expect(getStoredTask()).toMatchObject({
      due_date: '2026-06-01T09:30:00Z',
      due_all_day: false,
    });
  });

  it('an explicit due_all_day overrides derivation (the PWA preserving an unrelated edit)', async () => {
    const { db, getStoredTask } = dbWithTask(taskRow());

    // A bare date would normally derive due_all_day: true — explicit false wins.
    await db.updateTask('t_abc12', { due_date: '2026-06-01', due_all_day: false });

    expect(getStoredTask()).toMatchObject({
      due_date: '2026-06-01T12:00:00Z',
      due_all_day: false,
    });
  });

  // Codex-flagged (PR #40): a due_all_day-only PATCH — no due_date rewrite —
  // must still take effect. This is how an ambiguous noon-UTC row left NULL
  // by the migration backfill gets corrected after the fact.
  it('a due_all_day-only update (no due_date) is applied, not silently dropped', async () => {
    const { db, getStoredTask } = dbWithTask(taskRow({
      due_date: '2026-06-01T12:00:00Z',
      due_all_day: null,
    }));

    const result = await db.updateTask('t_abc12', { due_all_day: false });

    expect(result).toMatchObject({ due_date: '2026-06-01T12:00:00Z', due_all_day: false });
    expect(getStoredTask()).toMatchObject({ due_date: '2026-06-01T12:00:00Z', due_all_day: false });
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
      // defer's `until` is written through the minute-resolution parser
      // (Decision 4) — milliseconds are truncated on write.
      expected: { defer_kind: 'until', defer_until: '2026-05-16T09:00:00Z' },
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

  // Codex-flagged (PR #40): parseDeferInput's minute-resolution truncation
  // only runs when defer_kind is also present in the same PATCH — a
  // standalone defer_until update on a task already defer_kind: 'until'
  // used to copy the raw value straight into the patch, persisting
  // seconds/millis in violation of Decision 4.
  it('truncates a standalone defer_until update (no defer_kind in the PATCH) to minute resolution', async () => {
    const { db, getStoredTask } = dbWithTask(taskRow({
      defer_kind: 'until',
      defer_until: '2026-05-16T09:00:00Z',
    }));

    const result = await db.updateTask('t_abc12', {
      defer_until: '2026-05-16T10:30:45.123Z',
    });

    expect(result).toMatchObject({ defer_until: '2026-05-16T10:30:00Z' });
    expect(getStoredTask()).toMatchObject({ defer_until: '2026-05-16T10:30:00Z' });
  });
});
