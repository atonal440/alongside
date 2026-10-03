import { describe, expect, it } from 'vitest';
import { DB } from '../src/db';
import { callCommandTool } from '../src/commands';
import { handleMcpRequest } from '../src/mcp';
import { sqliteD1 } from './helpers/sqliteD1';

const base = { intent: true, contractVersion: 2 };
const preview = (db: DB, args: unknown) => callCommandTool('preview_changes', args, db) as Promise<any>;
const apply = (db: DB, args: unknown) => callCommandTool('apply_changes', args, db) as Promise<any>;

describe('loose-intent preview_changes', () => {
  it('lets an LLM create a project, move three tasks and link two with one preview and one apply', async () => {
    const { sql, d1 } = sqliteD1(); const db = new DB(d1);
    try {
      const [a, b, c] = await Promise.all(['A', 'B', 'C'].map(title => db.addTask({ title })));
      const result = await preview(db, { ...base, commands: [
        { kind: 'project.create', clientRef: 'proj', values: { title: 'Garden' } },
        { kind: 'task.project.set', id: a!.id, project: '@proj' },
        { kind: 'task.project.set', id: b!.id, project: '@proj' },
        { kind: 'task.project.set', id: c!.id, project: '@proj' },
        { kind: 'link.add', from: a!.id, to: b!.id },
        { kind: 'link.add', from: b!.id, to: c!.id, linkType: 'blocks' },
      ] });
      expect(result.dryRun).toBe(true);
      expect(result.changes.length).toBeGreaterThanOrEqual(6);
      expect(await db.listAllLinks()).toEqual([]);                 // preview wrote nothing
      const pinned = result.pinnedEnvelope;
      expect(pinned.expectedStructuralRevision).toBeTypeOf('number');
      expect(pinned.commandId).toMatch(/^c_/);
      const applied = await apply(db, pinned);                     // passed through unchanged
      expect(applied.applied).toBe(true);
      const projectId = applied.refs.proj;
      expect((await db.listAllTasks()).every(t => t.project_id === projectId)).toBe(true);
      expect(await db.listAllLinks()).toHaveLength(2);
      expect(await apply(db, pinned)).toEqual(applied);            // retry replays the receipt
    } finally { sql.close(); }
  });

  it('fills revisions and merges content patches into current values', async () => {
    const { sql, d1 } = sqliteD1(); const db = new DB(d1);
    try {
      const task = await db.addTask({ title: 'Old', notes: 'keep me', kickoff_note: 'kick' });
      const result = await preview(db, { ...base, commandId: 'c_mine001', commands: [{ kind: 'task.content.set', id: task.id, values: { title: 'New' } }] });
      expect(result.pinnedEnvelope.commandId).toBe('c_mine001');
      expect(result.pinnedEnvelope.expectedStructuralRevision).toBeUndefined();   // standalone
      expect(result.pinnedEnvelope.commands[0]).toMatchObject({ expectedRevision: expect.any(Number), values: { title: 'New', notes: 'keep me', kickoffNote: 'kick', sessionLog: null } });
      await apply(db, result.pinnedEnvelope);
      expect(await db.getTask(task.id)).toMatchObject({ title: 'New', notes: 'keep me', kickoff_note: 'kick' });
    } finally { sql.close(); }
  });

  it('mints a successor only for recurring completions', async () => {
    const { sql, d1 } = sqliteD1(); const db = new DB(d1);
    try {
      const plain = await db.addTask({ title: 'Once' });
      const weekly = await db.addTask({ title: 'Weekly', due_date: '2026-10-05', recurrence: 'FREQ=WEEKLY' });
      const one = await preview(db, { ...base, commands: [{ kind: 'task.complete', id: plain.id }] });
      expect(one.pinnedEnvelope.commands[0].successor).toBeNull();
      const two = await preview(db, { ...base, commands: [{ kind: 'task.complete', id: weekly.id, clientRef: 'next' }] });
      expect(two.pinnedEnvelope.commands[0].successor).toMatchObject({ id: expect.stringMatching(/^t_/), clientRef: 'next' });
      const done = await apply(db, two.pinnedEnvelope);
      expect(done.refs.next).toBe(two.pinnedEnvelope.commands[0].successor.id);
    } finally { sql.close(); }
  });

  it('turns a concurrent edit between preview and apply into revision_conflict', async () => {
    const { sql, d1 } = sqliteD1(); const db = new DB(d1);
    try {
      const task = await db.addTask({ title: 'Race' });
      const { pinnedEnvelope } = await preview(db, { ...base, commands: [{ kind: 'task.focus.set', id: task.id, focusedUntil: '2099-01-01T00:00:00Z' }] });
      await db.updateTask(task.id, { title: 'Changed' });
      await expect(apply(db, pinnedEnvelope)).rejects.toMatchObject({ detail: { code: 'revision_conflict' } });
    } finally { sql.close(); }
  });

  it('still accepts strict envelopes unchanged and returns no pinnedEnvelope for them', async () => {
    const { sql, d1 } = sqliteD1(); const db = new DB(d1);
    try {
      const task = await db.addTask({ title: 'Strict' });
      const loose = await preview(db, { ...base, commands: [{ kind: 'task.reopen', id: task.id }] }).catch(e => e);
      expect(loose.detail?.code).toBe('invalid_transition');        // planner still validates pinned commands
      const strict = { contractVersion: 2, commandId: 'c_strict01', actor: 'user', commands: [{ kind: 'task.focus.set', id: task.id, expectedRevision: (await db.getEntitySnapshot({ entity: 'task', id: task.id } as never)).version!.revision, focusedUntil: '2099-01-01T00:00:00Z' }] };
      const result = await preview(db, strict);
      expect(result.pinnedEnvelope).toBeUndefined();
      expect(result.dryRun).toBe(true);
    } finally { sql.close(); }
  });

  it.each([
    [{ kind: 'task.content.set', id: 't_missing', values: { title: 'x' } }, 'does not exist'],
    [{ kind: 'task.focus.set', id: '@nope', focusedUntil: '2099-01-01T00:00:00Z' }, 'No earlier command'],
    [{ kind: 'task.reopen', id: 't_abcde', surprise: 1 }, 'Unknown key'],
    [{ kind: 'link.remove', from: 't_abcde', to: 't_fghij' }, 'does not exist'],
    [{ kind: 'task.explode' }, 'Unknown command kind'],
  ])('rejects bad loose command %j', async (command, message) => {
    const { sql, d1 } = sqliteD1(); const db = new DB(d1);
    try { await expect(preview(db, { ...base, commands: [command] })).rejects.toMatchObject({ detail: { code: 'invalid_input', message: expect.stringContaining(message) } }); } finally { sql.close(); }
  });

  it('is available over MCP tools/call', async () => {
    const { sql, d1 } = sqliteD1(); const db = new DB(d1);
    try {
      const request = new Request('https://t/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'preview_changes', arguments: { ...base, commands: [{ kind: 'task.create', values: { title: 'Via MCP' } }] } } }) });
      const body = await (await handleMcpRequest(request, db, { DB: d1, AUTH_TOKEN: 't' })).json() as any;
      expect(body.result.structuredContent.pinnedEnvelope.commands[0]).toMatchObject({ kind: 'task.create', expectedRevision: null });
    } finally { sql.close(); }
  });
});
