import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DB } from '../../src/db';
import { handleApiRequest } from '../../src/api';
import { applyPlan, checkPlanCapacity } from '../../src/storage/apply';
import type { Plan } from '../../src/domain/Op';
import type { Project } from '@shared/types';

const now = '2026-09-30T23:00:00.123Z';
function project(index: number): Project {
  return { id: `p_${String(index).padStart(5, '0')}`, title: `Project ${index}`, status: 'active', notes: null, kickoff_note: null, created_at: now, updated_at: now };
}
function sqliteD1() {
  const sql = new DatabaseSync(':memory:');
  sql.exec('PRAGMA foreign_keys = ON');
  sql.exec(readFileSync(fileURLToPath(new URL('../../schema.sql', import.meta.url)), 'utf8'));
  let reads = 0;
  const batches: number[] = [];
  function prepare(query: string) {
    let args: unknown[] = [];
    return {
      sql: query,
      getArgs: () => args,
      bind(...values: unknown[]) { args = values; return this; },
      async first() { reads++; return sql.prepare(query).get(...args as never[]) ?? null; },
      async all() { reads++; return { results: sql.prepare(query).all(...args as never[]), success: true }; },
    };
  }
  const d1 = { prepare, async batch(statements: ReturnType<typeof prepare>[]) {
    batches.push(statements.length);
    sql.exec('BEGIN');
    try {
      const results = statements.map(statement => {
        sql.prepare(statement.sql).run(...statement.getArgs() as never[]);
        return { success: true, results: [], meta: {} };
      });
      sql.exec('COMMIT');
      return results;
    } catch (error) { sql.exec('ROLLBACK'); throw error; }
  } } as unknown as D1Database;
  return { d1, sql, batches, reads: () => reads };
}
const inserts = (count: number): Plan => ({ assertions: [], ops: Array.from({ length: count }, (_, index) => ({ kind: 'project.insert', row: project(index) })) });

describe('atomic SQL acceptance', () => {
  it('accepts exactly 100 actual statements in one batch', async () => {
    const { d1, sql, batches } = sqliteD1();
    expect(checkPlanCapacity(d1, inserts(100))).toEqual({ ok: true, value: { requiredStatements: 100, limit: 100 } });
    expect(await applyPlan(d1, inserts(100))).toEqual({ ok: true, value: { appliedOps: 100 } });
    expect(batches).toEqual([100]);
    expect(sql.prepare('SELECT count(*) AS n FROM projects').get()).toMatchObject({ n: 100 });
    sql.close();
  });
  it('counts SQL guards, logs and wipe effects rather than op count', async () => {
    const { d1, sql, batches, reads } = sqliteD1();
    sql.exec(`INSERT INTO tasks(id,title,created_at,updated_at) VALUES('t_abc12','Existing','${now}','${now}')`);
    const plan: Plan = {
      assertions: [{ kind: 'task.exists', id: 't_abc12' }],
      ops: [
        { kind: 'wipe' },
        ...inserts(92).ops,
        { kind: 'task.update', id: 't_abc12', patch: { title: 'Updated' } },
        { kind: 'log.insert', entry: { id: 1, tool_name: 'test', task_id: null, duty_id: null, title: 'Log', detail: null, created_at: now } },
      ],
    };
    // 1 assertion + 5 wipe statements + 92 inserts + 2 update statements + 1 log.
    expect(plan.ops).toHaveLength(95);
    expect(await applyPlan(d1, plan)).toEqual({ ok: false, error: { kind: 'capacity_exceeded', requiredStatements: 101, limit: 100 } });
    expect(reads()).toBe(0);
    expect(batches).toEqual([]);
    expect(sql.prepare('SELECT title FROM tasks').get()).toMatchObject({ title: 'Existing' });
    sql.close();
  });
  it('counts an empty allowlisted patch as no SQL', () => {
    const { d1, sql } = sqliteD1();
    expect(checkPlanCapacity(d1, { assertions: [], ops: [{ kind: 'task.update', id: 't_abc12', patch: {} }] })).toEqual({ ok: true, value: { requiredStatements: 0, limit: 100 } });
    sql.close();
  });
  it('rolls back a wipe and prior inserts when a later statement fails', async () => {
    const { d1, sql, batches } = sqliteD1();
    sql.exec(`INSERT INTO projects(id,title,created_at,updated_at) VALUES('p_old12','Original','${now}','${now}'); INSERT INTO tasks(id,title,created_at,updated_at,project_id) VALUES('t_old12','Original task','${now}','${now}','p_old12')`);
    const plan: Plan = { assertions: [], ops: [{ kind: 'wipe' }, { kind: 'project.insert', row: project(1) }, { kind: 'project.insert', row: project(1) }] };
    expect(await applyPlan(d1, plan)).toMatchObject({ ok: false, error: { kind: 'storage' } });
    expect(batches).toEqual([7]);
    expect(sql.prepare('SELECT id,title FROM projects').all()).toEqual([{ id: 'p_old12', title: 'Original' }]);
    expect(sql.prepare('SELECT id,title FROM tasks').all()).toEqual([{ id: 't_old12', title: 'Original task' }]);
    sql.close();
  });
  it.each([false, true])('rejects oversized v1 import before any read/write (dry-run %s)', async dryRun => {
    const { d1, sql, batches, reads } = sqliteD1();
    sql.exec(`INSERT INTO projects(id,title,created_at,updated_at) VALUES('p_old12','Keep me','${now}','${now}')`);
    const db = new DB(d1);
    const payload = { version: 1, exported_at: now, projects: Array.from({ length: 96 }, (_, i) => project(i)), tasks: [], links: [], preferences: {} };
    await expect(db.importAll(payload, dryRun)).rejects.toMatchObject({ appError: { kind: 'capacity_exceeded', requiredStatements: 101, limit: 100 } });
    expect(reads()).toBe(0);
    expect(batches).toEqual([]);
    expect(sql.prepare('SELECT title FROM projects').get()).toMatchObject({ title: 'Keep me' });
    sql.close();
  });
  it('returns structured capacity diagnostics from the existing REST import adapter', async () => {
    const { d1, sql, batches } = sqliteD1();
    const payload = { version: 1, exported_at: now, projects: Array.from({ length: 96 }, (_, i) => project(i)), tasks: [], links: [], preferences: {} };
    const request = new Request('https://alongside.test/api/import', { method: 'POST', body: JSON.stringify(payload) });
    const response = await handleApiRequest(request, new URL(request.url), new DB(d1));
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: 'capacity_exceeded', requiredStatements: 101, limit: 100, retryable: false });
    expect(batches).toEqual([]);
    sql.close();
  });
});
