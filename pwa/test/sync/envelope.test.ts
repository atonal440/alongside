import { describe, expect, it } from 'vitest';
import { buildEnvelope, type BuildContext, type CommandOp } from '../../src/sync/envelope';
import { parseTaskRow } from '@shared/wire/rows';
import { taskRow } from '../helpers/syncFixtures';
import type { Intent } from '../../src/sync/intent';

const parsedRow = (extra: Record<string, unknown> = {}) => { const r = parseTaskRow(taskRow('t_abc001', { title: 'Server title', notes: 'server notes', session_log: 'log', ...extra })); if (!r.ok) throw new Error('fixture'); return r.value; };
const op = (intent: Intent, base: number | null = 3): CommandOp => ({ op: 'command', commandId: 'c_cmd0001', intent, base, created_at: 'x', attempts: 0 });
const ctx = (over: Partial<BuildContext> = {}): BuildContext => ({ row: parsedRow(), structuralRevision: 12, projectRevision: 5, ...over });
const build = (intent: Intent, base: number | null = 3, c: BuildContext = ctx()) => buildEnvelope(op(intent, base), c);
const command = (intent: Intent, base: number | null = 3, c: BuildContext = ctx()) => { const r = build(intent, base, c); if (!r.ok) throw new Error(JSON.stringify(r.error)); return r.value.commands[0]!; };

describe('buildEnvelope', () => {
  it('creates with a null revision guard, the current aggregate revision and the client ID', () => {
    expect(command({ kind: 'task.create', id: 't_new001', title: 'Hi', notes: null, kickoffNote: null, taskType: 'action' }, null, ctx({ row: null })))
      .toMatchObject({ kind: 'task.create', id: 't_new001', expectedRevision: null, expectedStructuralRevision: 12, values: { title: 'Hi', project: null } });
  });

  it('guards edits with the revision they were made against, not the current one', () => {
    expect(command({ kind: 'task.focus', id: 't_abc001', focusedUntil: '2026-10-05T12:00:00Z' }, 3, ctx())).toMatchObject({ kind: 'task.focus.set', expectedRevision: 3 });
  });

  it('a content edit fills the unchanged fields from the current row', () => {
    expect(command({ kind: 'task.content', id: 't_abc001', title: 'Mine' })).toMatchObject({ kind: 'task.content.set', values: { title: 'Mine', notes: 'server notes', kickoffNote: null, sessionLog: 'log' } });
    expect(command({ kind: 'task.content', id: 't_abc001', notes: null })).toMatchObject({ values: { title: 'Server title', notes: null } });
  });

  it('schedule edits merge with the current schedule', () => {
    const c = ctx({ row: parsedRow({ due_date: '2026-10-05T12:00:00Z', due_all_day: true, recurrence: null }) });
    expect(command({ kind: 'task.schedule', id: 't_abc001', recurrence: 'FREQ=WEEKLY' }, 3, c)).toMatchObject({ kind: 'task.legacy-schedule.set', values: { dueDate: '2026-10-05T12:00:00Z', dueAllDay: true, recurrence: 'FREQ=WEEKLY' } });
  });

  it('maps type, project (with the project revision), defer, reopen, delete and complete', () => {
    expect(command({ kind: 'task.type', id: 't_abc001', taskType: 'plan' })).toMatchObject({ kind: 'task.type.set', taskType: 'plan' });
    expect(command({ kind: 'task.project', id: 't_abc001', projectId: 'p_proj01' })).toMatchObject({ kind: 'task.project.set', expectedStructuralRevision: 12, project: { id: 'p_proj01', expectedRevision: 5 } });
    expect(command({ kind: 'task.project', id: 't_abc001', projectId: null })).toMatchObject({ project: null });
    expect(command({ kind: 'task.defer', id: 't_abc001', defer: { kind: 'someday' } })).toMatchObject({ kind: 'task.defer.set', defer: { kind: 'someday' } });
    expect(command({ kind: 'task.reopen', id: 't_abc001' })).toMatchObject({ kind: 'task.reopen' });
    expect(command({ kind: 'task.delete', id: 't_abc001' })).toMatchObject({ kind: 'task.delete', expectedStructuralRevision: 12 });
  });

  it('completion carries a successor only when the task recurs', () => {
    expect(command({ kind: 'task.complete', id: 't_abc001', successorId: 't_next01' })).toMatchObject({ kind: 'task.complete', successor: null });
    const recurring = ctx({ row: parsedRow({ due_date: '2026-10-05T12:00:00Z', due_all_day: true, recurrence: 'FREQ=DAILY' }) });
    expect(command({ kind: 'task.complete', id: 't_abc001', successorId: 't_next01' }, 3, recurring)).toMatchObject({ successor: { id: 't_next01' } });
  });

  it('links use the aggregate guard, and related links are written in ascending order', () => {
    expect(command({ kind: 'link.add', from: 't_zzz001', to: 't_aaa001', linkType: 'related' }, 0)).toMatchObject({ kind: 'link.add', from: 't_aaa001', to: 't_zzz001', expectedRevision: 0, expectedStructuralRevision: 12 });
    expect(command({ kind: 'link.remove', from: 't_aaa001', to: 't_bbb001', linkType: 'blocks' }, 2)).toMatchObject({ kind: 'link.remove', expectedRevision: 2 });
  });

  it('refuses commands it cannot guard or aim', () => {
    expect(build({ kind: 'task.focus', id: 't_abc001', focusedUntil: null }, null)).toMatchObject({ ok: false, error: [{ code: 'missing_base' }] });
    expect(build({ kind: 'task.focus', id: 't_abc001', focusedUntil: null }, 3, ctx({ row: null }))).toMatchObject({ ok: false, error: [{ code: 'task_missing' }] });
    expect(build({ kind: 'task.content', id: 't_abc001', title: '' }).ok).toBe(false);
  });

  it('uses the op command ID and a single standalone command', () => {
    const r = build({ kind: 'task.reopen', id: 't_abc001' });
    if (!r.ok) throw new Error('x');
    expect(r.value.commandId).toBe('c_cmd0001');
    expect(r.value.commands).toHaveLength(1);
    expect(r.value.expectedStructuralRevision).toBeUndefined();
  });
});
