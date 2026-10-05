import { describe, expect, it } from 'vitest';
import { DB } from '../src/db';
import { callCommandTool } from '../src/commands';
import { callReadTool } from '../src/reads';
import { sqliteD1 } from './helpers/sqliteD1';
import { effectiveDates, hasActiveBlocker, hasDoneAncestor, isAvailable, isReady, readiness, readinessScore } from '@shared/readiness';
import type { Task, TaskLink } from '@shared/schema';

const NOW = '2026-10-05T12:00:00Z';
const day = (date: string) => JSON.stringify({ kind: 'date', date, timezone: 'UTC' });
const task = (id: string, over: Partial<Task> = {}): Task => ({
  id, title: id, notes: null, status: 'pending', project_id: null, parent_id: null, position: null,
  due_date: null, deadline: null, available_from: null, defer_kind: 'none', defer_until: null, focused_until: null,
  kickoff_note: null, session_log: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', ...over,
} as unknown as Task);
const blocks = (from: string, to: string): TaskLink => ({ from_task_id: from, to_task_id: to, link_type: 'blocks' } as TaskLink);

describe('effective dates', () => {
  it('takes the earliest deadline and latest opening along the ancestor chain, with sources', () => {
    const tasks = [
      task('root', { deadline: day('2026-11-01'), available_from: day('2026-10-01') }),
      task('mid', { parent_id: 'root', deadline: day('2026-12-01'), available_from: day('2026-10-20') }),
      task('leaf', { parent_id: 'mid', deadline: day('2026-10-30') }),
    ];
    const effective = effectiveDates(tasks[2]!, tasks);
    expect(effective.deadline).toEqual({ at: '2026-10-31T00:00:00Z', sourceId: 'leaf' });
    expect(effective.availableFrom).toEqual({ at: '2026-10-20T00:00:00Z', sourceId: 'mid' });
    expect(effective.windowEmpty).toBe(false);
    // The child's later deadline never extends the parent's: the parent's wins for a child dated later.
    const later = [tasks[0]!, task('late', { parent_id: 'root', deadline: day('2027-01-01') })];
    expect(effectiveDates(later[1]!, later).deadline).toMatchObject({ sourceId: 'root' });
  });

  it('flags an empty window without changing either task', () => {
    const tasks = [task('p', { deadline: day('2026-10-10') }), task('c', { parent_id: 'p', available_from: day('2026-10-20') })];
    const result = readiness(tasks[1]!, [], tasks, NOW);
    expect(result.effective.windowEmpty).toBe(true);
    expect(result.warnings.map(warning => warning.code)).toContain('empty_window');
  });

  it('holds a subtask back until an ancestor opens', () => {
    const tasks = [task('p', { available_from: day('2999-01-01') }), task('c', { parent_id: 'p' })];
    expect(isAvailable(tasks[1]!, NOW)).toBe(true);           // own date only
    expect(isAvailable(tasks[1]!, NOW, tasks)).toBe(false);   // with ancestors
    const result = readiness(tasks[1]!, [], tasks, NOW);
    expect(result.reasons).toEqual([{ code: 'not_yet_available', opensAt: '2999-01-01T00:00:00Z', sourceId: 'p' }]);
    expect(readinessScore(tasks[1]!, NOW, [], tasks)).toBe(5);
  });

  it('applies an ancestor\'s prerequisites to its descendants and names them', () => {
    const tasks = [task('gate'), task('p'), task('c', { parent_id: 'p' })];
    const links = [blocks('gate', 'p')];
    expect(hasActiveBlocker(tasks[2]!, links, tasks)).toBe(true);
    expect(readiness(tasks[2]!, links, tasks, NOW).reasons).toEqual([{ code: 'blocked_by', taskId: 'gate', via: 'p' }]);
    expect(isReady(tasks[2]!, links, tasks, NOW)).toBe(false);
    const done = [{ ...tasks[0]!, status: 'done' as const }, tasks[1]!, tasks[2]!];
    expect(isReady(tasks[2]!, links, done, NOW)).toBe(true);
  });

  it('reports every closed gate and keeps a parent with open subtasks ready', () => {
    const tasks = [task('p', { status: 'done' }), task('c', { parent_id: 'p', defer_kind: 'someday' })];
    expect(readiness(tasks[1]!, [], tasks, NOW).reasons.map(reason => reason.code)).toEqual(['deferred', 'ancestor_done']);
    expect(hasDoneAncestor(tasks[1]!, tasks)).toBe(true);
    const plain = [task('p', { status: 'done' }), task('c', { parent_id: 'p' })];
    expect(readinessScore(plain[1]!, NOW, [], plain)).toBe(5);
    const parent = [task('p'), task('c', { parent_id: 'p' })];
    const result = readiness(parent[0]!, [], parent, NOW);
    expect(result.ready).toBe(true);
    expect(result.warnings).toEqual([{ code: 'open_subtasks', count: 1 }]);
  });

  it('survives a parent loop and a missing parent', () => {
    const loop = [task('a', { parent_id: 'b' }), task('b', { parent_id: 'a' }), task('o', { parent_id: 'gone' })];
    expect(readiness(loop[0]!, [], loop, NOW).ready).toBe(true);
    expect(readiness(loop[2]!, [], loop, NOW).ready).toBe(true);
  });
});

describe('readiness in reads', () => {
  it('get_context explains a blocked subtask and ready tasks follow inherited gates', async () => {
    const { sql, d1 } = sqliteD1(); const db = new DB(d1);
    try {
      const gate = await db.addTask({ title: 'Gate' });
      const parent = await db.addTask({ title: 'Parent' });
      const child = await db.addTask({ title: 'Child' });
      const structural = async (id: string) => (await db.getEntitySnapshot({ entity: 'task', id } as never)).structuralRevision;
      await callCommandTool('apply_changes', { contractVersion: 2, commandId: 'c_eff00001', actor: 'llm', commands: [
        { kind: 'task.parent.set', id: child.id, expectedRevision: 1, expectedStructuralRevision: await structural(child.id), parent: { id: parent.id, expectedRevision: 1 }, position: null },
      ] }, db);
      await callCommandTool('apply_changes', { contractVersion: 2, commandId: 'c_eff00002', actor: 'llm', commands: [
        { kind: 'link.add', from: gate.id, to: parent.id, linkType: 'blocks', expectedRevision: null, expectedStructuralRevision: await structural(parent.id) },
      ] }, db);
      const context = await callReadTool('get_context', { entity: 'task', id: child.id }, db) as any;
      expect(context.context.readiness.ready).toBe(false);
      expect(context.context.readiness.reasons).toEqual([{ code: 'blocked_by', taskId: gate.id, via: parent.id }]);
      expect((await db.listReadyTasks()).map(row => row.title).sort()).toEqual(['Gate']);
    } finally { sql.close(); }
  });
});
