import { describe, expect, it } from 'vitest';
import type { Project, Task } from '@shared/types';
import { DB } from '../src/db';
import { planImport } from '../src/domain/ops/import';
import { parseImport } from '../src/wire/importPayload';

interface FakeStatement {
  sql: string;
  args: unknown[];
  bind(...args: unknown[]): FakeStatement;
  first<T>(): Promise<T | null>;
  run(): Promise<D1Result>;
}

function expectOk<T, E>(result: { ok: true; value: T } | { ok: false; error: E }): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('Expected ok result.');
  return result.value;
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

function taskRow(overrides: Partial<Task> = {}): Task {
  return {
    id: 't_abc12',
    title: 'Draft launch checklist',
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

function exportPayload(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    exported_at: '2026-05-15T12:00:00.000Z',
    projects: [projectRow()],
    tasks: [taskRow({ project_id: 'p_abc12' })],
    links: [],
    preferences: {},
    ...overrides,
  };
}

function fakeD1(): {
  d1: D1Database;
  batches: FakeStatement[][];
} {
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
          return null as T | null;
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

describe('import payload parsing', () => {
  it('preserves title whitespace while still requiring non-blank titles', () => {
    const parsed = expectOk(parseImport(exportPayload({
      projects: [projectRow({ title: '  Launch  ' })],
      tasks: [taskRow({ title: '  Draft launch checklist  ', project_id: 'p_abc12' })],
    })));

    expect(parsed.projects[0].title).toBe('  Launch  ');
    expect(parsed.tasks[0].title).toBe('  Draft launch checklist  ');

    const invalid = parseImport(exportPayload({
      tasks: [taskRow({ title: '   ', project_id: 'p_abc12' })],
    }));
    expect(invalid.ok).toBe(false);
  });

  it('normalizes legacy snoozed_until task rows into current defer fields', () => {
    const { defer_kind: _deferKind, defer_until: _deferUntil, ...legacyTask } = taskRow({
      project_id: 'p_abc12',
    });
    const parsed = expectOk(parseImport(exportPayload({
      tasks: [{
        ...legacyTask,
        snoozed_until: '2026-05-16T09:00:00.000Z',
      }],
    })));

    expect(parsed.tasks[0]).toMatchObject({
      defer_kind: 'until',
      defer_until: '2026-05-16T09:00:00.000Z',
    });
  });
});

describe('planImport', () => {
  it('builds a wipe-and-restore plan in dependency order', () => {
    const parsed = expectOk(parseImport(exportPayload({
      tasks: [
        taskRow({ id: 't_first1', project_id: 'p_abc12' }),
        taskRow({ id: 't_second1', project_id: 'p_abc12', title: 'Second task' }),
      ],
      links: [{ from_task_id: 't_first1', to_task_id: 't_second1', link_type: 'blocks' }],
      preferences: { sort_by: 'due' },
      action_log: [{
        id: 1,
        tool_name: 'add_task',
        task_id: 't_first1',
        title: 'Draft launch checklist',
        detail: null,
        created_at: '2026-05-15T12:05:00.000Z',
      }],
    })));

    const plan = expectOk(planImport(parsed));

    expect(plan.assertions).toEqual([]);
    expect(plan.ops.map(op => op.kind)).toEqual([
      'wipe',
      'project.insert',
      'task.insert',
      'task.insert',
      'link.upsert',
      'pref.upsert',
      'log.insert',
    ]);
  });

  it('rejects duplicate task ids before storage planning succeeds', () => {
    const parsed = expectOk(parseImport(exportPayload({
      tasks: [
        taskRow({ id: 't_dupe1' }),
        taskRow({ id: 't_dupe1', title: 'Duplicate' }),
      ],
    })));

    const result = planImport(parsed);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({ kind: 'validation' });
      expect(result.error.kind === 'validation' && result.error.errors).toContainEqual(expect.objectContaining({
        path: ['tasks', '1', 'id'],
        code: 'duplicate',
      }));
    }
  });

  it('rejects task, link, recurrence, and preference integrity violations together', () => {
    const parsed = expectOk(parseImport(exportPayload({
      tasks: [taskRow({
        id: 't_bad12',
        project_id: 'p_missing',
        due_date: null,
        recurrence: 'FREQ=DAILY',
      })],
      links: [{ from_task_id: 't_bad12', to_task_id: 't_missing', link_type: 'blocks' }],
      preferences: { sort_by: 'alphabetical' },
    })));

    const result = planImport(parsed);

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'validation') {
      expect(result.error.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ['tasks', '0', 'due_date'], code: 'required' }),
        expect.objectContaining({ path: ['tasks', '0', 'project_id'], code: 'unknown_reference' }),
        expect.objectContaining({ path: ['links', '0', 'to_task_id'], code: 'unknown_reference' }),
        expect.objectContaining({ path: ['preferences', 'sort_by', 'value'], code: 'picklist' }),
      ]));
    }
  });

  it('rejects self-links and blocks cycles in imported links', () => {
    const parsed = expectOk(parseImport(exportPayload({
      tasks: [
        taskRow({ id: 't_one11' }),
        taskRow({ id: 't_two22', title: 'Two' }),
        taskRow({ id: 't_thr33', title: 'Three' }),
      ],
      links: [
        { from_task_id: 't_one11', to_task_id: 't_one11', link_type: 'related' },
        { from_task_id: 't_one11', to_task_id: 't_two22', link_type: 'blocks' },
        { from_task_id: 't_two22', to_task_id: 't_thr33', link_type: 'blocks' },
        { from_task_id: 't_thr33', to_task_id: 't_one11', link_type: 'blocks' },
      ],
    })));

    const result = planImport(parsed);

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'validation') {
      expect(result.error.errors).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: ['links', '0', 'to_task_id'], code: 'invalid_state' }),
        expect.objectContaining({ path: ['links'], code: 'cycle' }),
      ]));
    }
  });
});

describe('DB.importAll', () => {
  it('rejects invalid small payloads before the wipe batch is built', async () => {
    const { d1, batches } = fakeD1();
    const db = new DB(d1);

    await expect(db.importAll(exportPayload({
      tasks: [
        taskRow({ id: 't_dupe1' }),
        taskRow({ id: 't_dupe1', title: 'Duplicate' }),
      ],
    }))).rejects.toMatchObject({
      appError: { kind: 'validation' },
    });
    expect(batches).toHaveLength(0);
  });

  it('applies a parsed import through the shared plan executor', async () => {
    const { d1, batches } = fakeD1();
    const db = new DB(d1);

    const result = await db.importAll(exportPayload({
      preferences: { sort_by: 'project' },
    }));

    expect(result).toEqual({
      dry_run: false,
      inserted: {
        projects: 1,
        tasks: 1,
        links: 0,
        preferences: 1,
        action_log: 0,
      },
    });
    expect(batches).toHaveLength(1);
    expect(batches[0].map(statement => statement.sql).slice(0, 6)).toEqual([
      'DELETE FROM task_links',
      'DELETE FROM action_log',
      'DELETE FROM tasks',
      'DELETE FROM projects',
      'DELETE FROM user_preferences',
      'INSERT INTO projects (id,title,notes,kickoff_note,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)',
    ]);
  });
});
