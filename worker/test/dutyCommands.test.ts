import { describe, expect, it } from 'vitest';
import { DB } from '../src/db';
import { callCommandTool } from '../src/commands';
import { callReadTool } from '../src/reads';
import { sqliteD1 } from './helpers/sqliteD1';

const apply = (db: DB, args: unknown, options?: { source?: 'mcp' | 'rest' }) => callCommandTool('apply_changes', args, db, options) as Promise<any>;
const preview = (db: DB, args: unknown) => callCommandTool('preview_changes', args, db) as Promise<any>;
let n = 0;
const cid = () => `c_duty${String(++n).padStart(4, '0')}`;
const structural = async (db: DB) => (await db.getEntitySnapshot({ entity: 'task', id: 't_probe' } as never)).structuralRevision;
const schedule = { rrule: 'FREQ=DAILY', dtstart: '2026-01-01T09:00:00Z', timezone: 'America/Chicago' };
const values = (over: object = {}) => ({ title: 'Water plants', notes: null, kickoffNote: null, taskType: 'action', project: null, catchUp: 'next', schedule, ...over });
async function create(db: DB, id: string, over: object = {}) {
  return apply(db, { contractVersion: 2, commandId: cid(), actor: 'user', commands: [{ kind: 'duty.create', id, expectedRevision: null, expectedStructuralRevision: await structural(db), values: values(over) }] });
}
const revision = async (db: DB, id: string) => (await db.getEntitySnapshot({ entity: 'duty', id } as never)).version!.revision;
const status = (db: DB, id: string, to: string, expected?: number) => revision(db, id).then(current => apply(db, { contractVersion: 2, commandId: cid(), actor: 'user',
  commands: [{ kind: 'duty.status.set', id, expectedRevision: expected ?? current, status: to }] }));

describe.each(['fresh', 'upgrade'] as const)('duty commands (%s)', mode => {
  it('creates a duty whose next occurrence is the first at or after its start, and replays idempotently', async () => {
    const { sql, d1 } = sqliteD1(mode); const db = new DB(d1);
    try {
      const commandId = cid();
      const envelope = { contractVersion: 2, commandId, actor: 'user', commands: [{ kind: 'duty.create', id: 'd_water', clientRef: 'water', expectedRevision: null, expectedStructuralRevision: await structural(db), values: values({ schedule: { ...schedule, rrule: 'FREQ=WEEKLY;BYDAY=MO' } }) }] };
      const result = await apply(db, envelope);
      expect(result.changes[0]).toMatchObject({ entity: 'duty', id: 'd_water', before: null, after: { revision: 1, row: { status: 'active', last_spawned_at: null, next_occurrence_at: '2026-01-05T09:00:00Z', catch_up: 'next', timezone: 'America/Chicago' } } });
      expect(result.refs).toEqual({ water: 'd_water' });
      expect(sql.prepare("SELECT status,rrule FROM duties WHERE id='d_water'").get()).toEqual({ status: 'active', rrule: 'FREQ=WEEKLY;BYDAY=MO' });
      expect(await apply(db, envelope)).toEqual(result);
      expect(sql.prepare('SELECT COUNT(*) AS n FROM duties').get()).toEqual({ n: 1 });
      await expect(create(db, 'd_water')).rejects.toMatchObject({ detail: { code: 'revision_conflict' } });
    } finally { sql.close(); }
  });

  it('rejects schedules that cannot produce an occurrence or are not supported', async () => {
    const { sql, d1 } = sqliteD1(mode); const db = new DB(d1);
    try {
      await expect(create(db, 'd_none', { schedule: { ...schedule, rrule: 'FREQ=DAILY;UNTIL=20251231T000000Z' } })).rejects.toMatchObject({ detail: { code: 'invalid_input' } });
      await expect(create(db, 'd_bad01', { schedule: { ...schedule, rrule: 'FREQ=SECONDLY' } })).rejects.toMatchObject({ detail: { code: 'invalid_input' } });
      await expect(create(db, 'd_bad02', { schedule: { ...schedule, timezone: 'Mars/Olympus' } })).rejects.toMatchObject({ detail: { code: 'invalid_input' } });
      expect(sql.prepare('SELECT COUNT(*) AS n FROM duties').get()).toEqual({ n: 0 });
    } finally { sql.close(); }
  });

  it('links a duty to a project at the revision the caller saw', async () => {
    const { sql, d1 } = sqliteD1(mode); const db = new DB(d1);
    try {
      const project = await db.createProject({ title: 'Home' });
      await create(db, 'd_home1', { project: { id: project.id, expectedRevision: 1 } });
      expect(sql.prepare("SELECT project_id FROM duties WHERE id='d_home1'").get()).toEqual({ project_id: project.id });
      await expect(create(db, 'd_home2', { project: { id: project.id, expectedRevision: 9 } })).rejects.toMatchObject({ detail: { code: 'revision_conflict' } });
    } finally { sql.close(); }
  });

  it('pauses, resumes and ends, and refuses to leave the ended state', async () => {
    const { sql, d1 } = sqliteD1(mode); const db = new DB(d1);
    try {
      await create(db, 'd_cycle');
      expect((await status(db, 'd_cycle', 'paused')).changes[0].after.row.status).toBe('paused');
      await expect(status(db, 'd_cycle', 'paused')).rejects.toMatchObject({ detail: { code: 'invalid_transition' } });
      expect((await status(db, 'd_cycle', 'active')).changes[0].after.row.status).toBe('active');
      const ended = await status(db, 'd_cycle', 'ended');
      expect(ended.changes[0].after.row).toMatchObject({ status: 'ended', next_occurrence_at: null });
      await expect(status(db, 'd_cycle', 'active')).rejects.toMatchObject({ detail: { code: 'invalid_transition' } });
      await expect(status(db, 'd_cycle', 'paused', 1)).rejects.toMatchObject({ detail: { code: 'revision_conflict' } });
    } finally { sql.close(); }
  });

  it('edits the template for future occurrences without touching the schedule or generated tasks', async () => {
    const { sql, d1 } = sqliteD1(mode); const db = new DB(d1);
    try {
      await create(db, 'd_tmpl1');
      await db.materializeDueDuties('2026-01-01T20:00:00Z' as never);
      const generated = sql.prepare("SELECT id,title FROM tasks WHERE duty_id='d_tmpl1'").get() as { id: string; title: string };
      expect(generated.title).toBe('Water plants');
      const content = { title: 'Water the ferns', notes: 'Mist them', kickoffNote: null, taskType: 'plan', project: null, catchUp: 'all' };
      const result = await apply(db, { contractVersion: 2, commandId: cid(), actor: 'user', commands: [{ kind: 'duty.content.set', id: 'd_tmpl1', expectedRevision: await revision(db, 'd_tmpl1'), values: content }] });
      expect(result.changes[0].after.row).toMatchObject({ title: 'Water the ferns', task_type: 'plan', catch_up: 'all', rrule: 'FREQ=DAILY', dtstart: '2026-01-01T09:00:00Z' });
      expect(sql.prepare('SELECT title FROM tasks WHERE id=?').get(generated.id)).toEqual({ title: 'Water plants' });
      await db.materializeDueDuties('2026-01-02T20:00:00Z' as never);
      expect(sql.prepare("SELECT title,task_type FROM tasks WHERE duty_id='d_tmpl1' ORDER BY occurrence_at DESC").get()).toEqual({ title: 'Water the ferns', task_type: 'plan' });
    } finally { sql.close(); }
  });

  it('pins loose intent, defaults the zone to the workspace, and keeps duties out of batches', async () => {
    const { sql, d1 } = sqliteD1(mode); const db = new DB(d1);
    try {
      await apply(db, { contractVersion: 2, commandId: cid(), actor: 'user', commands: [{ kind: 'planning.set', expectedRevision: null, values: { timezone: 'America/Chicago', workingHours: [], bufferMinutes: 0 } }] });
      const planned = await preview(db, { intent: true, contractVersion: 2, commands: [{ kind: 'duty.create', clientRef: 'q', values: { title: 'Check the queue', schedule: { rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', dtstart: '2026-10-06T14:00:00Z' } } }] });
      const row = planned.diff?.changes?.[0]?.after?.row ?? planned.changes?.[0]?.after?.row;
      expect(row).toMatchObject({ title: 'Check the queue', timezone: 'America/Chicago', catch_up: 'next', task_type: 'action', status: 'active' });
      const applied = await apply(db, planned.pinnedEnvelope);
      const id = applied.refs.q as string;
      const loose = await preview(db, { intent: true, contractVersion: 2, commands: [{ kind: 'duty.status.set', id, status: 'paused' }] });
      expect((await apply(db, loose.pinnedEnvelope)).changes[0].after.row.status).toBe('paused');
      await expect(preview(db, { intent: true, contractVersion: 2, commands: [{ kind: 'duty.create', values: { title: 'a', schedule: schedule } }, { kind: 'task.create', clientRef: 't', values: { title: 'b' } }] }))
        .rejects.toMatchObject({ detail: { code: 'invalid_input' } });
    } finally { sql.close(); }
  });

  it('records duty commands in the action log and the sync feed when applied through MCP', async () => {
    const { sql, d1 } = sqliteD1(mode); const db = new DB(d1);
    try {
      await apply(db, { contractVersion: 2, commandId: cid(), actor: 'llm', commands: [{ kind: 'duty.create', id: 'd_logged', expectedRevision: null, expectedStructuralRevision: await structural(db), values: values() }] }, { source: 'mcp' });
      expect(sql.prepare("SELECT tool_name,title FROM action_log WHERE tool_name='duty.create'").get()).toEqual({ tool_name: 'duty.create', title: 'Water plants' });
      expect(sql.prepare("SELECT COUNT(*) AS n FROM sync_feed WHERE entity='duty' AND entity_key='d_logged'").get()).toEqual({ n: 1 });
    } finally { sql.close(); }
  });

  it('finds duties and reads one with its project and recent instances', async () => {
    const { sql, d1 } = sqliteD1(mode); const db = new DB(d1);
    try {
      const project = await db.createProject({ title: 'Home' });
      await create(db, 'd_read01', { project: { id: project.id, expectedRevision: 1 } });
      await create(db, 'd_read02', { title: 'Old habit' });
      await status(db, 'd_read02', 'ended');
      const found = await callReadTool('find', { entity: 'duty' }, db) as any;
      expect(found.items.map((duty: any) => duty.id)).toEqual(['d_read01']);
      const all = await callReadTool('find', { entity: 'duty', filter: { status: 'ended' } }, db) as any;
      expect(all.items.map((duty: any) => duty.id)).toEqual(['d_read02']);
      const byProject = await callReadTool('find', { entity: 'duty', filter: { project_id: project.id } }, db) as any;
      expect(byProject.items.map((duty: any) => duty.id)).toEqual(['d_read01']);
      await expect(callReadTool('find', { entity: 'duty', filter: { text: 'x' } }, db)).rejects.toMatchObject({ detail: { code: 'invalid_input' } });
      const context = await callReadTool('get_context', { entity: 'duty', id: 'd_read01' }, db) as any;
      expect(context.row.id).toBe('d_read01');
      expect(context.context.project.id).toBe(project.id);
      // The find above lazily materialized the due occurrence, so the instance exists by now.
      expect(context.context.recent_instances.length).toBeGreaterThan(0);
      expect(context.context.recent_instances.every((task: any) => task.duty_id === 'd_read01')).toBe(true);
      expect(((await callReadTool('describe_commands', { family: 'duty' }, db)) as any).commands.map((variant: any) => variant.properties.kind.const)).toEqual(['duty.create', 'duty.content.set', 'duty.status.set']);
    } finally { sql.close(); }
  });
});
