import { describe, expect, it } from 'vitest';
import { DB } from '../src/db';
import { callReadTool } from '../src/reads';
import { callCommandTool } from '../src/commands';
import { TOOLS } from '../src/mcp';
import { CommandEnvelopeSchema } from '@shared/wire/commands';
import { parseSchema } from '@shared/parse';
import { sqliteD1 } from './helpers/sqliteD1';

async function seeded() {
  const { sql, d1 } = sqliteD1();
  const db = new DB(d1);
  const project = await db.createProject({ title: 'Garden' });
  const a = await db.addTask({ title: 'Dig bed', notes: 'with the SPADE', project_id: project.id });
  const b = await db.addTask({ title: 'Plant seeds', project_id: project.id });
  const c = await db.addTask({ title: 'Buy tea' });
  await db.linkTasks(a.id, b.id, 'blocks');
  await db.linkTasks(a.id, c.id, 'related');
  return { sql, db, project, a, b, c };
}

describe('find', () => {
  it('matches the legacy list_tasks, get_ready_tasks and list_projects results', async () => {
    const { sql, db, project, a } = await seeded();
    try {
      const legacy = await db.listAllTasks(['pending']);
      const found = await callReadTool('find', { entity: 'task' }, db) as { items: { id: string }[]; nextCursor: null };
      expect(found.items.map(t => t.id).sort()).toEqual(legacy.map(t => t.id).sort());
      expect(found.nextCursor).toBeNull();
      const ready = await callReadTool('find', { entity: 'task', preset: 'ready' }, db) as { items: { id: string }[] };
      expect(ready.items.map(t => t.id)).toEqual((await db.listReadyTasks()).map(t => t.id));
      expect(ready.items.map(t => t.id)).not.toContain((await db.listAllTasks()).find(t => t.title === 'Plant seeds')!.id);
      const scoped = await callReadTool('find', { entity: 'task', preset: 'ready', filter: { project_id: project.id } }, db) as { items: { id: string }[] };
      expect(scoped.items.map(t => t.id)).toEqual([a.id]);
      const projects = await callReadTool('find', { entity: 'project' }, db) as { items: { id: string }[] };
      expect(projects.items.map(p => p.id)).toEqual([project.id]);
      expect((await callReadTool('find', { entity: 'project', filter: { status: 'archived' } }, db) as { items: unknown[] }).items).toEqual([]);
    } finally { sql.close(); }
  });

  it('searches text case-insensitively over title and notes', async () => {
    const { sql, db, a, c } = await seeded();
    try {
      const byNotes = await callReadTool('find', { entity: 'task', filter: { text: 'spade' } }, db) as { items: { id: string }[] };
      expect(byNotes.items.map(t => t.id)).toEqual([a.id]);
      const byTitle = await callReadTool('find', { entity: 'task', filter: { text: 'TEA' } }, db) as { items: { id: string }[] };
      expect(byTitle.items.map(t => t.id)).toEqual([c.id]);
    } finally { sql.close(); }
  });

  it('pages deterministically with a cursor and rejects a stale one', async () => {
    const { sql, db } = await seeded();
    try {
      const first = await callReadTool('find', { entity: 'task', limit: 2 }, db) as { items: { id: string }[]; nextCursor: string };
      expect(first.items).toHaveLength(2);
      const second = await callReadTool('find', { entity: 'task', limit: 2, cursor: first.nextCursor }, db) as { items: { id: string }[]; nextCursor: null };
      expect(second.items).toHaveLength(1);
      expect(second.nextCursor).toBeNull();
      expect(new Set([...first.items, ...second.items].map(t => t.id)).size).toBe(3);
      await expect(callReadTool('find', { entity: 'task', cursor: 't_gone' }, db)).rejects.toMatchObject({ detail: { code: 'invalid_input' } });
    } finally { sql.close(); }
  });

  it.each([
    { entity: 'task', filter: { status: 'active' } },
    { entity: 'project', filter: { statuses: ['pending'] } },
    { entity: 'task', preset: 'ready', filter: { statuses: ['done'] } },
    { entity: 'task', limit: 0 },
    { entity: 'thing' },
    { entity: 'task', surprise: true },
  ])('rejects invalid input %j', async input => {
    const { sql, db } = await seeded();
    try { await expect(callReadTool('find', input, db)).rejects.toMatchObject({ detail: { code: 'invalid_input' } }); } finally { sql.close(); }
  });
});

describe('get_context', () => {
  it('depth 0 equals get_entity / get_link / get_planning_settings', async () => {
    const { sql, db, a, b, project } = await seeded();
    try {
      for (const key of [{ entity: 'task', id: a.id }, { entity: 'project', id: project.id }, { entity: 'task', id: 't_missing' }]) {
        expect(await callReadTool('get_context', { ...key, depth: 0 }, db)).toEqual(await callCommandTool('get_entity', key, db));
      }
      const link = { entity: 'link', from: a.id, to: b.id, linkType: 'blocks' };
      expect(await callReadTool('get_context', { ...link, depth: 0 }, db)).toEqual(await callCommandTool('get_link', link, db));
      expect(await callReadTool('get_context', { entity: 'settings' }, db)).toEqual(await callCommandTool('get_planning_settings', {}, db));
    } finally { sql.close(); }
  });

  it('adds the task neighborhood by default', async () => {
    const { sql, db, a, b, c, project } = await seeded();
    try {
      const ctx = await callReadTool('get_context', { entity: 'task', id: b.id }, db) as any;
      expect(ctx.row.id).toBe(b.id);
      expect(ctx.version.revision).toBeGreaterThanOrEqual(0);
      expect(ctx.context.project.id).toBe(project.id);
      expect(ctx.context.prerequisites.map((t: any) => t.id)).toEqual([a.id]);
      expect(ctx.context.dependents).toEqual([]);
      const first = await callReadTool('get_context', { entity: 'task', id: a.id }, db) as any;
      expect(first.context.dependents.map((t: any) => t.id)).toEqual([b.id]);
      expect(first.context.related.map((t: any) => t.id)).toEqual([c.id]);
    } finally { sql.close(); }
  });

  it('adds ready tasks to a project and returns tombstones/missing rows unchanged', async () => {
    const { sql, db, a, project } = await seeded();
    try {
      const ctx = await callReadTool('get_context', { entity: 'project', id: project.id }, db) as any;
      expect(ctx.context.ready_tasks.map((t: any) => t.id)).toEqual((await db.listReadyTasks(project.id)).map(t => t.id));
      expect(ctx.context.ready_tasks.map((t: any) => t.id)).toEqual([a.id]);
      expect(ctx.context.task_counts).toEqual({ pending: 2, done: 0 });
      expect(await callReadTool('get_context', { entity: 'task', id: 't_missing' }, db)).toMatchObject({ row: null, version: null });
    } finally { sql.close(); }
  });
});

describe('get_history', () => {
  it('merges action-log entries with the command audit, newest first', async () => {
    const { sql, db, a } = await seeded();
    try {
      await db.logAction({ tool_name: 'add_task', task_id: a.id, title: a.title });
      const { structuralRevision } = await callCommandTool('get_entity', { entity: 'task', id: a.id }, db) as { structuralRevision: number };
      await db.applyChanges(parseCommand({ contractVersion: 2, commandId: 'c_history1', actor: 'llm', commands: [{ kind: 'task.create', id: 't_history1', expectedRevision: null, expectedStructuralRevision: structuralRevision, values: { title: 'From command', notes: null, kickoffNote: null, taskType: 'action', project: null } }] }));
      const { entries } = await callReadTool('get_history', {}, db) as { entries: { source: string; at: string }[] };
      expect(new Set(entries.map(e => e.source))).toEqual(new Set(['action_log', 'command']));
      expect([...entries].sort((x, y) => y.at.localeCompare(x.at))).toEqual(entries);
      expect(entries.find(e => e.source === 'command')).toMatchObject({ command_id: 'c_history1', actor: 'llm' });
    } finally { sql.close(); }
  });
});

function parseCommand(input: unknown) {
  const parsed = parseSchema(CommandEnvelopeSchema, input);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
  return parsed.value;
}

describe('describe_commands', () => {
  it.each(['task', 'project', 'link', 'planning'])('returns only %s variants and a valid example', async family => {
    const { sql, db } = await seeded();
    try {
      const described = await callReadTool('describe_commands', { family }, db) as any;
      expect(described.commands.length).toBeGreaterThan(0);
      for (const variant of described.commands) expect(variant.properties.kind.const.startsWith(`${family}.`)).toBe(true);
      expect(parseSchema(CommandEnvelopeSchema, described.example).ok).toBe(true);
      expect(described.errorCodes).toContain('revision_conflict');
    } finally { sql.close(); }
  });

  it('covers every command kind apply_changes accepts', async () => {
    const { sql, db } = await seeded();
    try {
      const kinds = new Set<string>();
      for (const family of ['task', 'project', 'link', 'planning']) for (const variant of (await callReadTool('describe_commands', { family }, db) as any).commands) kinds.add(variant.properties.kind.const);
      const applyTool = (await import('../src/commands')).COMMAND_TOOLS.find(tool => tool.name === 'apply_changes')!;
      expect(kinds.size).toBe((applyTool.inputSchema.properties.commands.items.oneOf as unknown[]).length);
      await expect(callReadTool('describe_commands', { family: 'series' }, db)).rejects.toMatchObject({ detail: { code: 'invalid_input' } });
    } finally { sql.close(); }
  });
});

describe('deprecation notices', () => {
  it('points each replaced read tool at its successor and leaves the rest alone', () => {
    const description = (name: string) => TOOLS.find(tool => tool.name === name)!.description;
    expect(description('list_tasks')).toMatch(/^Deprecated: use find\(/);
    expect(description('get_ready_tasks')).toContain('preset: "ready"');
    expect(description('get_action_log')).toMatch(/^Deprecated: use get_history\./);
    expect(description('get_entity')).toContain('get_context');
    expect(description('add_task')).not.toMatch(/Deprecated/);
    expect(description('find')).not.toMatch(/Deprecated/);
  });
});
