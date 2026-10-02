import { describe, expect, it } from 'vitest';
import { canonicalFromSnapshot } from '../../src/sync/canonical';
import { predictBase } from '../../src/sync/base';
import { linkIdentity } from '../../src/sync/intent';
import type { PendingOp } from '../../src/api/pendingOps';
import { snapshot, taskImage, tombstone } from '../helpers/syncFixtures';

const cmd = (intent: Record<string, unknown>) => ({ op: 'command', commandId: 'c_x00001', base: 0, created_at: 'x', attempts: 0, intent }) as PendingOp;
const link = { entity: 'link', key: JSON.stringify(['t_a0001', 't_b0001', 'blocks']), revision: 4, deletedAt: null, row: { from_task_id: 't_a0001', to_task_id: 't_b0001', link_type: 'blocks' } };
const ws = canonicalFromSnapshot(snapshot({ epoch: 1, sequence: 9 }, [taskImage('t_a0001', 3), taskImage('t_b0001', 1), link, tombstone('task', 't_gone01', 7)]));

describe('predictBase', () => {
  it('is the canonical revision when nothing is queued, and null for unknown identities', () => {
    expect(predictBase(ws, [], 'task:t_a0001')).toBe(3);
    expect(predictBase(ws, [], 'task:t_nope01')).toBeNull();
    expect(predictBase(ws, [], linkIdentity('t_a0001', 't_b0001', 'blocks'))).toBe(4);
  });

  it('advances by one for each queued command that writes the identity', () => {
    const ops = [cmd({ kind: 'task.content', id: 't_a0001', title: 'x' }), cmd({ kind: 'task.focus', id: 't_a0001', focusedUntil: null }), cmd({ kind: 'task.content', id: 't_b0001', title: 'y' })];
    expect(predictBase(ws, ops, 'task:t_a0001')).toBe(5);
    expect(predictBase(ws, ops, 'task:t_b0001')).toBe(2);
  });

  it('a queued create makes a new identity revision 1, and the next edit expects it', () => {
    const create = cmd({ kind: 'task.create', id: 't_new001', title: 't', notes: null, kickoffNote: null, taskType: 'action' });
    expect(predictBase(ws, [create], 'task:t_new001')).toBe(1);
    expect(predictBase(ws, [create, cmd({ kind: 'task.content', id: 't_new001', title: 'u' })], 'task:t_new001')).toBe(2);
  });

  it('completing a recurring task also advances its successor identity; tombstones keep counting', () => {
    const ops = [cmd({ kind: 'task.complete', id: 't_a0001', successorId: 't_next01' })];
    expect(predictBase(ws, ops, 'task:t_next01')).toBe(1);
    expect(predictBase(ws, [cmd({ kind: 'link.remove', from: 't_a0001', to: 't_b0001', linkType: 'blocks' })], linkIdentity('t_a0001', 't_b0001', 'blocks'))).toBe(5);
    expect(predictBase(ws, [], 'task:t_gone01')).toBe(7);
  });

  it('ignores legacy queue entries it cannot reason about', () => {
    const legacy = { op: 'task.update', taskId: 't_a0001', body: { title: 'x' }, created_at: 'x', attempts: 0 } as PendingOp;
    expect(predictBase(ws, [legacy], 'task:t_a0001')).toBe(3);
  });
});
