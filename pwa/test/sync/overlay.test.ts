import { describe, expect, it } from 'vitest';
import { canonicalFromSnapshot } from '../../src/sync/canonical';
import { overlayPendingOps } from '../../src/sync/overlay';
import type { PendingOp } from '../../src/api/pendingOps';
import { projectImage, snapshot, taskImage } from '../helpers/syncFixtures';

const at = '2026-10-02T09:00:00.000Z';
const op = (payload: Record<string, unknown>) => ({ created_at: at, attempts: 0, ...payload }) as PendingOp;
const base = () => canonicalFromSnapshot(snapshot({ epoch: 1, sequence: 5 }, [
  taskImage('t_aaaaa1', 1), taskImage('t_bbbbb1', 1), projectImage('p_first1', 1),
  { entity: 'link', key: JSON.stringify(['t_aaaaa1', 't_bbbbb1', 'blocks']), revision: 1, deletedAt: null, row: { from_task_id: 't_aaaaa1', to_task_id: 't_bbbbb1', link_type: 'blocks' } },
]));

describe('overlayPendingOps', () => {
  it('returns canonical state untouched for an empty queue', () => {
    const view = overlayPendingOps(base(), []);
    expect(view.tasks.map(t => t.id).sort()).toEqual(['t_aaaaa1', 't_bbbbb1']);
    expect(view.projects).toHaveLength(1);
    expect(view.links).toHaveLength(1);
    expect(view.outcomes).toEqual([]);
  });

  it('replays creates, edits and completion in queue order, and never mutates the base', () => {
    const b = base();
    const view = overlayPendingOps(b, [
      op({ op: 'task.create', localId: 't_local01', body: { title: 'New' } }),
      op({ op: 'task.update', taskId: 't_local01', body: { title: 'Renamed' } }),
      op({ op: 'task.complete', taskId: 't_local01' }),
      op({ op: 'task.update', taskId: 't_aaaaa1', body: { notes: 'n' } }),
    ]);
    expect(view.outcomes.every(o => o.kind === 'applied')).toBe(true);
    expect(view.tasks.find(t => t.id === 't_local01')).toMatchObject({ title: 'Renamed', status: 'done' });
    expect(view.tasks.find(t => t.id === 't_aaaaa1')?.notes).toBe('n');
    expect(b.entities.get('task:t_aaaaa1')?.row).toMatchObject({ notes: null });
  });

  it('reports ops that no longer apply without blocking later ones', () => {
    const view = overlayPendingOps(base(), [
      op({ op: 'task.update', taskId: 't_gone01', body: { title: 'x' } }),
      op({ op: 'task.create', localId: 't_aaaaa1', body: { title: 'dup' } }),
      op({ op: 'task.update', taskId: 't_aaaaa1', body: { title: 'ok' } }),
      op({ op: 'task.update', taskId: 't_aaaaa1', body: { recurrence: 'FREQ=DAILY' } }),
    ]);
    expect(view.outcomes.map(o => (o.kind === 'skipped' ? o.reason : 'applied'))).toEqual(['task_missing', 'task_exists', 'applied', 'invalid']);
    expect(view.tasks.find(t => t.id === 't_aaaaa1')?.title).toBe('ok');
  });

  it('deleting a task removes its links; link ops respect existing state', () => {
    const link = { from_task_id: 't_aaaaa1', to_task_id: 't_bbbbb1', link_type: 'blocks' };
    const dup = overlayPendingOps(base(), [op({ op: 'link.create', body: link }), op({ op: 'link.delete', body: link }), op({ op: 'link.delete', body: link })]);
    expect(dup.outcomes.map(o => (o.kind === 'skipped' ? o.reason : 'applied'))).toEqual(['link_exists', 'applied', 'link_missing']);
    const del = overlayPendingOps(base(), [op({ op: 'task.delete', taskId: 't_bbbbb1' }), op({ op: 'link.create', body: { ...link, link_type: 'related' } })]);
    expect(del.links).toEqual([]);
    expect(del.outcomes[1]).toMatchObject({ kind: 'skipped', reason: 'endpoint_missing' });
  });
});

describe('overlayPendingOps — reliable commands', () => {
  const cmd = (intent: Record<string, unknown>) => op({ op: 'command', commandId: 'c_x00001', base: 1, intent });

  it('replays create, edit, schedule, defer and completion intents in order', () => {
    const view = overlayPendingOps(base(), [
      cmd({ kind: 'task.create', id: 't_new0001', title: 'New', notes: null, kickoffNote: 'k', taskType: 'plan' }),
      cmd({ kind: 'task.content', id: 't_new0001', notes: 'details' }),
      cmd({ kind: 'task.focus', id: 't_aaaaa1', focusedUntil: '2026-10-03T12:00:00Z' }),
      cmd({ kind: 'task.complete', id: 't_bbbbb1', successorId: null }),
    ]);
    expect(view.outcomes.every(o => o.kind === 'applied')).toBe(true);
    expect(view.tasks.find(t => t.id === 't_new0001')).toMatchObject({ title: 'New', notes: 'details', kickoff_note: 'k', task_type: 'plan' });
    expect(view.tasks.find(t => t.id === 't_aaaaa1')?.focused_until).toBe('2026-10-03T12:00:00Z');
    expect(view.tasks.find(t => t.id === 't_bbbbb1')?.status).toBe('done');
  });

  it('deletes cascade to links; link intents respect existing state and endpoints', () => {
    const link = { from: 't_aaaaa1', to: 't_bbbbb1', linkType: 'blocks' };
    const dup = overlayPendingOps(base(), [cmd({ kind: 'link.add', ...link }), cmd({ kind: 'link.remove', ...link }), cmd({ kind: 'link.remove', ...link })]);
    expect(dup.outcomes.map(o => (o.kind === 'skipped' ? o.reason : 'applied'))).toEqual(['link_exists', 'applied', 'link_missing']);
    const del = overlayPendingOps(base(), [cmd({ kind: 'task.delete', id: 't_bbbbb1' }), cmd({ kind: 'link.add', ...link, linkType: 'related' })]);
    expect(del.links).toEqual([]);
    expect(del.outcomes[1]).toMatchObject({ kind: 'skipped', reason: 'endpoint_missing' });
  });

  it('skips intents for missing tasks and duplicate creates without blocking later ones', () => {
    const view = overlayPendingOps(base(), [
      cmd({ kind: 'task.reopen', id: 't_gone001' }),
      cmd({ kind: 'task.create', id: 't_aaaaa1', title: 'dup', notes: null, kickoffNote: null, taskType: 'action' }),
      cmd({ kind: 'task.type', id: 't_aaaaa1', taskType: 'plan' }),
    ]);
    expect(view.outcomes.map(o => (o.kind === 'skipped' ? o.reason : 'applied'))).toEqual(['task_missing', 'task_exists', 'applied']);
  });
});
