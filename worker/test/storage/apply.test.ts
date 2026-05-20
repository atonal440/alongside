import { describe, expect, it } from 'vitest';
import type { Project, Task } from '@shared/types';
import type { Plan, TaskRowPatch } from '../../src/domain/Op';
import { applyPlan } from '../../src/storage/apply';

const TASK_EXISTS_GUARD_SQL =
  "INSERT INTO tasks (title,status,created_at,updated_at,defer_kind,task_type) SELECT NULL,'pending','','','none','action' WHERE NOT EXISTS (SELECT 1 FROM tasks WHERE id = ?)";

const PROJECT_EXISTS_GUARD_SQL =
  "INSERT INTO projects (title,status,created_at,updated_at) SELECT NULL,'active','','' WHERE NOT EXISTS (SELECT 1 FROM projects WHERE id = ?)";

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
    title: 'Task',
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

function projectRow(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p_abc12',
    title: 'Project',
    notes: null,
    kickoff_note: null,
    status: 'active',
    created_at: '2026-05-15T12:00:00.000Z',
    updated_at: '2026-05-15T12:00:00.000Z',
    ...overrides,
  };
}

function fakeD1(options: {
  tasks?: string[];
  projects?: string[];
  deleteTasksBeforeBatch?: string[];
  deleteProjectsBeforeBatch?: string[];
} = {}): {
  d1: D1Database;
  prepared: FakeStatement[];
  batches: FakeStatement[][];
  executedStatements: FakeStatement[];
} {
  const tasks = new Set(options.tasks ?? []);
  const projects = new Set(options.projects ?? []);
  const prepared: FakeStatement[] = [];
  const batches: FakeStatement[][] = [];
  const executedStatements: FakeStatement[] = [];

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
          if (sql.includes('FROM projects')) return (projects.has(id) ? { id } : null) as T | null;
          return null;
        },
        async run() {
          return { success: true, meta: {} } as D1Result;
        },
      };
      prepared.push(statement);
      return statement;
    },
    async batch(statements: FakeStatement[]) {
      batches.push(statements);
      for (const id of options.deleteTasksBeforeBatch ?? []) tasks.delete(id);
      for (const id of options.deleteProjectsBeforeBatch ?? []) projects.delete(id);

      for (const statement of statements) {
        if (statement.sql === TASK_EXISTS_GUARD_SQL) {
          const id = String(statement.args[0]);
          if (!tasks.has(id)) throw new Error('NOT NULL constraint failed: tasks.title');
          continue;
        }
        if (statement.sql === PROJECT_EXISTS_GUARD_SQL) {
          const id = String(statement.args[0]);
          if (!projects.has(id)) throw new Error('NOT NULL constraint failed: projects.title');
          continue;
        }
        executedStatements.push(statement);
      }

      return statements.map(() => ({ success: true, meta: {} }) as D1Result);
    },
  } as unknown as D1Database;

  return { d1, prepared, batches, executedStatements };
}

describe('applyPlan', () => {
  it('applies task update and insert operations in one batch after prechecks pass', async () => {
    const { d1, batches } = fakeD1({ tasks: ['t_abc12'] });
    const nextTask = taskRow({ id: 't_next1', title: 'Next task' });
    const plan: Plan = {
      assertions: [{ kind: 'task.exists', id: 't_abc12' }],
      ops: [
        {
          kind: 'task.update',
          id: 't_abc12',
          patch: { status: 'done', updated_at: '2026-05-15T13:00:00.000Z' },
        },
        { kind: 'task.insert', row: nextTask },
      ],
    };

    const result = await applyPlan(d1, plan);

    expect(result).toEqual({ ok: true, value: { appliedOps: 2 } });
    expect(batches).toHaveLength(1);
    expect(batches[0].map(statement => statement.sql)).toEqual([
      TASK_EXISTS_GUARD_SQL,
      TASK_EXISTS_GUARD_SQL,
      'UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?',
      'INSERT INTO tasks (id,title,notes,status,due_date,recurrence,created_at,updated_at,defer_until,defer_kind,task_type,project_id,kickoff_note,session_log,focused_until) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ]);
  });

  it('runs task prechecks before mutations and skips batch on not found', async () => {
    const { d1, batches } = fakeD1();
    const plan: Plan = {
      assertions: [{ kind: 'task.exists', id: 't_missing' }],
      ops: [{ kind: 'task.delete', id: 't_missing' }],
    };

    const result = await applyPlan(d1, plan);

    expect(result).toEqual({ ok: false, error: { kind: 'not_found', entity: 'task', id: 't_missing' } });
    expect(batches).toHaveLength(0);
  });

  it('aborts with not found when an asserted row disappears before the batch mutates', async () => {
    const { d1, batches, executedStatements } = fakeD1({
      tasks: ['t_abc12'],
      deleteTasksBeforeBatch: ['t_abc12'],
    });
    const plan: Plan = {
      assertions: [{ kind: 'task.exists', id: 't_abc12' }],
      ops: [
        { kind: 'project.insert', row: projectRow() },
        {
          kind: 'task.update',
          id: 't_abc12',
          patch: { project_id: 'p_abc12', updated_at: '2026-05-15T13:00:00.000Z' },
        },
      ],
    };

    const result = await applyPlan(d1, plan);

    expect(result).toEqual({ ok: false, error: { kind: 'not_found', entity: 'task', id: 't_abc12' } });
    expect(batches).toHaveLength(1);
    expect(batches[0][0].sql).toBe(TASK_EXISTS_GUARD_SQL);
    expect(executedStatements).toHaveLength(0);
  });

  it('guards update targets even when a planner omitted the explicit precheck', async () => {
    const { d1, batches, executedStatements } = fakeD1();
    const plan: Plan = {
      assertions: [],
      ops: [
        {
          kind: 'task.update',
          id: 't_missing',
          patch: { status: 'done', updated_at: '2026-05-15T13:00:00.000Z' },
        },
      ],
    };

    const result = await applyPlan(d1, plan);

    expect(result).toEqual({ ok: false, error: { kind: 'not_found', entity: 'task', id: 't_missing' } });
    expect(batches).toHaveLength(1);
    expect(batches[0][0].sql).toBe(TASK_EXISTS_GUARD_SQL);
    expect(executedStatements).toHaveLength(0);
  });

  it('returns not found for missing project prechecks', async () => {
    const { d1, batches } = fakeD1();
    const plan: Plan = {
      assertions: [{ kind: 'project.exists', id: 'p_missing' }],
      ops: [],
    };

    const result = await applyPlan(d1, plan);

    expect(result).toEqual({ ok: false, error: { kind: 'not_found', entity: 'project', id: 'p_missing' } });
    expect(batches).toHaveLength(0);
  });

  it('chunks large unguarded plans for D1 batch limits', async () => {
    const { d1, batches } = fakeD1();
    const plan: Plan = {
      assertions: [],
      ops: Array.from({ length: 105 }, (_, index) => ({
        kind: 'project.insert' as const,
        row: projectRow({ id: `p_${String(index).padStart(5, '0')}` }),
      })),
    };

    const result = await applyPlan(d1, plan);

    expect(result).toEqual({ ok: true, value: { appliedOps: 105 } });
    expect(batches).toHaveLength(2);
    expect(batches.map(batch => batch.length)).toEqual([100, 5]);
  });

  it('clears task assignments before deleting a project', async () => {
    const { d1, batches } = fakeD1({ projects: ['p_abc12'] });
    const plan: Plan = {
      assertions: [],
      ops: [{ kind: 'project.delete', id: 'p_abc12' }],
    };

    const result = await applyPlan(d1, plan);

    expect(result).toEqual({ ok: true, value: { appliedOps: 1 } });
    expect(batches).toHaveLength(1);
    expect(batches[0].map(statement => statement.sql)).toEqual([
      PROJECT_EXISTS_GUARD_SQL,
      'UPDATE tasks SET project_id = NULL WHERE project_id = ?',
      'DELETE FROM projects WHERE id = ?',
    ]);
    expect(batches[0].map(statement => statement.args)).toEqual([
      ['p_abc12'],
      ['p_abc12'],
      ['p_abc12'],
    ]);
  });

  it('rejects unsupported prechecks before applying mutations', async () => {
    const { d1, batches } = fakeD1();
    const plan: Plan = {
      assertions: [{ kind: 'custom', description: 'wait for import slice' }],
      ops: [{ kind: 'task.delete', id: 't_abc12' }],
    };

    const result = await applyPlan(d1, plan);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({ kind: 'invariant_violation' });
    }
    expect(batches).toHaveLength(0);
  });

  it('only emits allowlisted task update columns', async () => {
    const { d1, batches } = fakeD1({ tasks: ['t_abc12'] });
    const patch = {
      title: 'Renamed',
      id: 't_hacked',
      created_at: '2026-05-01T00:00:00.000Z',
    } as unknown as TaskRowPatch;
    const plan: Plan = {
      assertions: [],
      ops: [{ kind: 'task.update', id: 't_abc12', patch }],
    };

    const result = await applyPlan(d1, plan);

    expect(result.ok).toBe(true);
    const updateStatement = batches[0].find(statement => statement.sql.startsWith('UPDATE tasks SET'));
    expect(updateStatement?.sql).toBe('UPDATE tasks SET title = ? WHERE id = ?');
    expect(updateStatement?.args).toEqual(['Renamed', 't_abc12']);
  });
});
