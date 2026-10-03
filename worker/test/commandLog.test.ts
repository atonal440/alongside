import { describe, expect, it } from 'vitest';
import { DB } from '../src/db';
import { handleMcpRequest } from '../src/mcp';
import { handleApiRequest } from '../src/api';
import { parseWorkspaceSnapshot } from '@shared/wire/sync';
import { sqliteD1 } from './helpers/sqliteD1';

type World = ReturnType<typeof sqliteD1>;
const withWorld = async (fn: (w: World, db: DB) => Promise<void>) => { const w = sqliteD1(); try { await fn(w, new DB(w.d1)); } finally { w.sql.close(); } };
const structural = async (db: DB) => (await db.getEntitySnapshot({ entity: 'task', id: 't_probe00' } as never)).structuralRevision;
async function applyViaMcp(w: World, db: DB, envelope: Record<string, unknown>) {
  const request = new Request('https://t/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'apply_changes', arguments: envelope } }) });
  const body = await (await handleMcpRequest(request, db, { DB: w.d1, AUTH_TOKEN: 't' })).json() as any;
  if (body.error) throw new Error(body.error.message);
  if (body.result.isError) throw Object.assign(new Error(body.result.content[0].text), { detail: body.result.structuredContent.error });
  return body.result.structuredContent;
}
const logRows = (w: World) => w.sql.prepare('SELECT tool_name, task_id, title, detail FROM action_log ORDER BY id').all() as { tool_name: string; task_id: string | null; title: string; detail: string | null }[];
const envelope = async (db: DB, commandId: string, commands: Record<string, unknown>[]) => {
  const s = await structural(db);
  return { contractVersion: 2, commandId, actor: 'llm', ...(commands.length > 1 ? { expectedStructuralRevision: s } : {}),
    commands: commands.map(c => 'expectedStructuralRevision' in c ? { ...c, expectedStructuralRevision: s } : c) };
};
const create = (id: string, title: string, extra: Record<string, unknown> = {}) => ({ kind: 'task.create', id, expectedRevision: null, expectedStructuralRevision: 0, values: { title, notes: null, kickoffNote: null, taskType: 'action', project: null }, ...extra });

describe('apply_changes records command kinds in the action log', () => {
  it('writes one entry per command, in order, with kind, task, title and detail', async () => withWorld(async (w, db) => {
    const project = { kind: 'project.create', id: 'p_logged1', expectedRevision: null, expectedStructuralRevision: 0, values: { title: 'Garden', notes: null, kickoffNote: null } };
    const assign = { kind: 'task.project.set', id: 't_logone1', expectedRevision: 1, expectedStructuralRevision: 0, project: { id: 'p_logged1', expectedRevision: 1 } };
    const link = { kind: 'link.add', from: 't_logone1', to: 't_logtwo1', linkType: 'blocks', expectedRevision: null, expectedStructuralRevision: 0 };
    await applyViaMcp(w, db, await envelope(db, 'c_logbatch', [project, create('t_logone1', 'Dig'), create('t_logtwo1', 'Plant'), assign, link]));
    expect(logRows(w)).toEqual([
      { tool_name: 'project.create', task_id: null, title: 'Garden', detail: null },
      { tool_name: 'task.create', task_id: 't_logone1', title: 'Dig', detail: null },
      { tool_name: 'task.create', task_id: 't_logtwo1', title: 'Plant', detail: null },
      { tool_name: 'task.project.set', task_id: 't_logone1', title: 'Dig', detail: 'Garden' },
      { tool_name: 'link.add', task_id: null, title: 'Dig → Plant', detail: 'blocks' },
    ]);
  }));

  it('logs each command of a composed batch and uses the final title', async () => withWorld(async (w, db) => {
    const schedule = { kind: 'task.legacy-schedule.set', id: 't_compos1', expectedRevision: 1, values: { dueDate: '2026-11-02', dueAllDay: true, recurrence: null } };
    const rename = { kind: 'task.content.set', id: 't_compos1', expectedRevision: 1, values: { title: 'Final', notes: null, kickoffNote: null, sessionLog: null } };
    await applyViaMcp(w, db, await envelope(db, 'c_logcomp1', [create('t_compos1', 'First'), schedule, rename]));
    expect(logRows(w).map(r => [r.tool_name, r.title, r.detail])).toEqual([
      ['task.create', 'Final', null], ['task.legacy-schedule.set', 'Final', '2026-11-02T12:00:00Z'], ['task.content.set', 'Final', null],
    ]);
  }));

  it('titles a link between existing tasks, and records completion, deferral, focus and deletion details', async () => withWorld(async (w, db) => {
    const [a, b] = [await db.addTask({ title: 'Alpha' }), await db.addTask({ title: 'Beta', due_date: '2026-10-05', recurrence: 'FREQ=WEEKLY' })];
    const [lo, hi] = a.id < b.id ? [a, b] : [b, a];            // related links need ascending endpoints; IDs are random
    const rev = async (id: string) => (await db.getEntitySnapshot({ entity: 'task', id } as never)).version!.revision;
    await applyViaMcp(w, db, await envelope(db, 'c_loglink1', [{ kind: 'link.add', from: lo.id, to: hi.id, linkType: 'related', expectedRevision: null, expectedStructuralRevision: 0 }]));
    await applyViaMcp(w, db, await envelope(db, 'c_logcomp2', [{ kind: 'task.complete', id: b.id, expectedRevision: await rev(b.id), expectedStructuralRevision: 0, successor: { id: 't_successor' } }]));
    await applyViaMcp(w, db, await envelope(db, 'c_logdefer1', [{ kind: 'task.defer.set', id: a.id, expectedRevision: await rev(a.id), defer: { kind: 'someday' } }]));
    await applyViaMcp(w, db, await envelope(db, 'c_logfocus1', [{ kind: 'task.focus.set', id: a.id, expectedRevision: await rev(a.id), focusedUntil: '2099-01-01T00:00:00Z' }]));
    await applyViaMcp(w, db, await envelope(db, 'c_logdel001', [{ kind: 'task.delete', id: a.id, expectedRevision: await rev(a.id), expectedStructuralRevision: 0 }]));
    expect(logRows(w).map(r => [r.tool_name, r.title, r.detail])).toEqual([
      ['link.add', `${lo.title} → ${hi.title}`, 'related'],
      ['task.complete', 'Beta', '→ recurs 2026-10-12T12:00:00Z'],
      ['task.defer.set', 'Alpha', 'someday'],
      ['task.focus.set', 'Alpha', '2099-01-01T00:00:00Z'],
      ['task.delete', 'Alpha', null],
    ]);
    expect(logRows(w).at(-1)!.task_id).toBe(a.id);                   // the deleted task's ID is kept, as delete_task does
  }));

  it('replays without writing again, and a failed command leaves no entry', async () => withWorld(async (w, db) => {
    const input = await envelope(db, 'c_logreplay', [create('t_replay01', 'Once')]);
    const first = await applyViaMcp(w, db, input);
    expect(await applyViaMcp(w, db, input)).toEqual(first);
    expect(logRows(w)).toHaveLength(1);
    await expect(applyViaMcp(w, db, await envelope(db, 'c_logfail01', [{ kind: 'task.reopen', id: 't_replay01', expectedRevision: 1 }]))).rejects.toMatchObject({ detail: { code: 'invalid_transition' } });
    w.hooks.failAfter = 2;
    await expect(applyViaMcp(w, db, await envelope(db, 'c_logfail02', [create('t_failing1', 'Lost')]))).rejects.toBeDefined();
    expect(logRows(w)).toHaveLength(1);
    expect(w.sql.prepare("SELECT COUNT(*) AS n FROM command_receipts WHERE command_id='c_logfail02'").get()).toEqual({ n: 0 });
  }));

  it('does not log settings commands, and REST apply stays silent', async () => withWorld(async (w, db) => {
    await applyViaMcp(w, db, { contractVersion: 2, commandId: 'c_logpref01', actor: 'user', commands: [{ kind: 'preference.set', key: 'sort_by', value: 'due', expectedRevision: null }] });
    await applyViaMcp(w, db, { contractVersion: 2, commandId: 'c_logplan01', actor: 'user', commands: [{ kind: 'planning.set', expectedRevision: null, values: { timezone: 'UTC', bufferMinutes: 0, workingHours: [] } }] });
    expect(logRows(w)).toEqual([]);
    const rest = new Request('https://t/api/v2/changes', { method: 'POST', body: JSON.stringify(await envelope(db, 'c_logrest01', [create('t_restone1', 'Via REST')])) });
    expect((await handleApiRequest(rest, new URL(rest.url), db)).status).toBe(200);
    expect(logRows(w)).toEqual([]);
  }));

  it('syncs command-kind entries to clients through the snapshot codec', async () => withWorld(async (w, db) => {
    await applyViaMcp(w, db, await envelope(db, 'c_logsync01', [create('t_syncone1', 'Synced')]));
    const parsed = parseWorkspaceSnapshot(JSON.parse(JSON.stringify(await db.getWorkspaceSnapshot())));
    expect(parsed.ok).toBe(true);
    const row = (await db.getWorkspaceSnapshot()).entities.find((e: any) => e.entity === 'action_log') as any;
    expect(row.row.tool_name).toBe('task.create');
  }));
});

describe('capacity counts the action-log rows an MCP apply adds', () => {
  const focusAll = async (db: DB, count: number) => {
    const tasks = await Promise.all(Array.from({ length: count }, (_, i) => db.addTask({ title: `Task ${i}` })));
    const commands = await Promise.all(tasks.map(async t => ({ kind: 'task.focus.set', id: t.id, expectedRevision: (await db.getEntitySnapshot({ entity: 'task', id: t.id } as never)).version!.revision, focusedUntil: '2099-01-01T00:00:00Z' })));
    return envelope(db, 'c_logcap001', commands);
  };
  it('refuses at preview, not only at apply, a batch whose log rows push it past the limit', async () => withWorld(async (w, db) => {
    const input = await focusAll(db, 20);
    expect((await db.previewChanges(input as never)).requiredStatements).toBe(83);   // REST: no log rows
    await expect(db.previewChanges(input as never, { actionLog: true })).rejects.toMatchObject({ status: 413, detail: { code: 'capacity_exceeded', requiredStatements: 103 } });
    await expect(applyViaMcp(w, db, input)).rejects.toMatchObject({ detail: { code: 'capacity_exceeded' } });
    expect(logRows(w)).toEqual([]);
  }));
});
