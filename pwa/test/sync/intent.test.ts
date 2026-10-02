import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import { applyIntentToTask, describeIntent, intentsFromPatch, intentWrites, IntentSchema, linkIdentity } from '../../src/sync/intent';
import { makeTask } from '../helpers/fixtures';
import type { TaskUpdatePatch } from '../../src/domain/taskMutations';

const task = makeTask({ id: 't_abc001', title: 'Old', notes: null, kickoff_note: null, task_type: 'action' });
const patch = (p: Record<string, unknown>) => p as TaskUpdatePatch;

describe('intentsFromPatch', () => {
  it('queues nothing for an unchanged form', () => {
    expect(intentsFromPatch(task, patch({ title: 'Old', notes: null, task_type: 'action' }))).toEqual([]);
  });

  it('splits a multi-field edit into one command per family, only for fields that differ', () => {
    const intents = intentsFromPatch(task, patch({ title: 'New', notes: 'n', kickoff_note: null, task_type: 'plan', project_id: 'p_proj01' }));
    expect(intents).toEqual([
      { kind: 'task.content', id: 't_abc001', title: 'New', notes: 'n' },
      { kind: 'task.type', id: 't_abc001', taskType: 'plan' },
      { kind: 'task.project', id: 't_abc001', projectId: 'p_proj01' },
    ]);
  });

  it('keeps schedule fields together and normalises defer/focus instants to the minute', () => {
    const s = intentsFromPatch(task, patch({ due_date: '2026-10-05T12:00:00Z', due_all_day: true, recurrence: 'FREQ=DAILY' }));
    expect(s).toEqual([{ kind: 'task.schedule', id: 't_abc001', dueDate: '2026-10-05T12:00:00Z', dueAllDay: true, recurrence: 'FREQ=DAILY' }]);
    expect(intentsFromPatch(task, patch({ defer_kind: 'until', defer_until: '2026-10-05T09:30:45.123Z' })))
      .toEqual([{ kind: 'task.defer', id: 't_abc001', defer: { kind: 'until', until: '2026-10-05T09:30:00Z' } }]);
    expect(intentsFromPatch(task, patch({ defer_kind: 'someday', defer_until: null }))).toEqual([{ kind: 'task.defer', id: 't_abc001', defer: { kind: 'someday' } }]);
    expect(intentsFromPatch(task, patch({ focused_until: '2026-10-05T12:00:59.999Z' }))).toEqual([{ kind: 'task.focus', id: 't_abc001', focusedUntil: '2026-10-05T12:00:00Z' }]);
  });

  it('a defer change is one command (the server clears focus), focus alone is one command', () => {
    const focused = makeTask({ id: 't_abc001', focused_until: '2026-10-06T00:00:00Z' });
    expect(intentsFromPatch(focused, patch({ defer_kind: 'someday', defer_until: null, focused_until: null }))).toHaveLength(1);
    expect(intentsFromPatch(task, patch({ focused_until: null }))).toEqual([]);
  });
});

describe('applyIntentToTask', () => {
  it('mirrors the server transitions', () => {
    const at = '2026-10-02T10:00:00.000Z';
    expect(applyIntentToTask(task, { kind: 'task.content', id: task.id, title: 'New' }, at)).toMatchObject({ title: 'New', notes: null, updated_at: at });
    expect(applyIntentToTask(task, { kind: 'task.defer', id: task.id, defer: { kind: 'someday' } }, at)).toMatchObject({ defer_kind: 'someday', defer_until: null, focused_until: null });
    expect(applyIntentToTask(task, { kind: 'task.focus', id: task.id, focusedUntil: '2026-10-02T12:00:00Z' }, at)).toMatchObject({ focused_until: '2026-10-02T12:00:00Z', defer_kind: 'none' });
    expect(applyIntentToTask(task, { kind: 'task.complete', id: task.id, successorId: null }, at)).toMatchObject({ status: 'done', focused_until: null });
    expect(applyIntentToTask({ ...task, status: 'done' }, { kind: 'task.reopen', id: task.id }, at).status).toBe('pending');
  });
});

describe('intent identity and schema', () => {
  it('lists the identities each intent writes', () => {
    expect(intentWrites({ kind: 'task.content', id: 't_a', title: 'x' })).toEqual(['task:t_a']);
    expect(intentWrites({ kind: 'task.complete', id: 't_a', successorId: 't_b' })).toEqual(['task:t_a', 'task:t_b']);
    expect(intentWrites({ kind: 'link.add', from: 't_a', to: 't_b', linkType: 'blocks' })).toEqual([linkIdentity('t_a', 't_b', 'blocks')]);
  });

  it('parses every intent shape and rejects unknown ones', () => {
    const ok = (i: unknown) => v.safeParse(IntentSchema, i).success;
    expect(ok({ kind: 'task.content', id: 't_a', title: 'x' })).toBe(true);
    expect(ok({ kind: 'task.defer', id: 't_a', defer: { kind: 'until', until: '2026-10-05T09:30:00Z' } })).toBe(true);
    expect(ok({ kind: 'link.add', from: 't_a', to: 't_b', linkType: 'blocks' })).toBe(true);
    expect(ok({ kind: 'link.add', from: 't_a', to: 't_b', linkType: 'parent' })).toBe(false);
    expect(ok({ kind: 'task.nope', id: 't_a' })).toBe(false);
    expect(ok({ kind: 'task.defer', id: 't_a', defer: { kind: 'until' } })).toBe(false);
    expect(describeIntent({ kind: 'task.create', id: 't_a', title: 'Hi', notes: null, kickoffNote: null, taskType: 'action' })).toBe('Create “Hi”');
  });
});
