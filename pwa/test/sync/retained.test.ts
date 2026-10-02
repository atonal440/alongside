import { describe, test, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { resetIdb } from '../helpers/idb';
import { closeDb } from '../../src/idb/db';
import { idbRetainOp, idbGetRetainedOps } from '../../src/idb/retainedOps';
import { idbGetPendingOps } from '../../src/idb/pendingOps';
import { idbGetAllTasks } from '../../src/idb/tasks';
import { makeTask } from '../helpers/fixtures';
import { describeRetainedOp, discardRetainedOp, rebaseView, retryRebased, retryRetainedOp } from '../../src/sync/retained';
import type { PendingOp } from '../../src/api/pendingOps';

const at = '2026-10-02T09:00:00.000Z';
const op = (p: Record<string, unknown>) => ({ created_at: at, attempts: 3, ...p }) as PendingOp;
beforeEach(async () => { closeDb(); await resetIdb(); });

async function seedRefusedCreate() {
  await idbRetainOp(op({ op: 'task.create', localId: 't_local01', body: { title: 'Mine' } }), { kind: 'rejected', status: 400, message: 'Invalid' });
  await idbRetainOp(op({ op: 'task.update', taskId: 't_local01', body: { notes: 'n' } }), { kind: 'dependency', dependsOn: 't_local01', message: 'dep' });
  await idbRetainOp(op({ op: 'task.complete', taskId: 't_other01' }), { kind: 'rejected', status: 409, message: 'stale' });
}

describe('retained op actions', () => {
  test('describes intent', async () => {
    await seedRefusedCreate();
    const all = await idbGetRetainedOps();
    expect(all.map(describeRetainedOp)).toEqual(['Create “Mine”', 'Edit task notes', 'Complete a task']);
  });

  test('retrying a refused create re-queues it and its dependents in order, with fresh attempts', async () => {
    await seedRefusedCreate();
    const [create] = await idbGetRetainedOps();
    expect(await retryRetainedOp(create!.id!)).toBe(2);
    const pending = await idbGetPendingOps();
    expect(pending.map(p => p.op)).toEqual(['task.create', 'task.update']);
    expect(pending.every(p => p.attempts === 0)).toBe(true);
    expect((await idbGetRetainedOps()).map(r => r.op.op)).toEqual(['task.complete']);
    expect((await idbGetAllTasks()).map(t => t.id)).toEqual(['t_local01']);
  });

  test('retrying an unrelated op touches only that op', async () => {
    await seedRefusedCreate();
    const all = await idbGetRetainedOps();
    expect(await retryRetainedOp(all[2]!.id!)).toBe(1);
    expect((await idbGetPendingOps()).map(p => p.op)).toEqual(['task.complete']);
    expect(await idbGetRetainedOps()).toHaveLength(2);
  });

  test('discarding a refused create drops its dependents too; unknown ids are a no-op', async () => {
    await seedRefusedCreate();
    const [create] = await idbGetRetainedOps();
    expect(await discardRetainedOp(create!.id!)).toBe(2);
    expect((await idbGetRetainedOps()).map(r => r.op.op)).toEqual(['task.complete']);
    expect(await discardRetainedOp(9999)).toBe(0);
    expect(await idbGetPendingOps()).toEqual([]);
  });
});

describe('rebasing a refused edit', () => {
  const edit = op({ op: 'task.update', taskId: 't_abc001', body: { title: 'Mine', notes: 'same' } });
  const seed = async () => { await idbRetainOp(edit, { kind: 'rejected', status: 409, message: 'stale' }); return (await idbGetRetainedOps())[0]!; };

  test('diffs intent against the current task and flags no-op fields', async () => {
    const r = await seed();
    const view = rebaseView(r, [makeTask({ id: 't_abc001', title: 'Theirs', notes: 'same' })]);
    expect(view).toEqual({ kind: 'fields', fields: [
      { field: 'title', intended: 'Mine', current: 'Theirs', differs: true },
      { field: 'notes', intended: 'same', current: 'same', differs: false },
    ] });
  });

  test('reports a vanished target and plain retries for other ops', async () => {
    const r = await seed();
    expect(rebaseView(r, [])).toMatchObject({ kind: 'missing' });
    await idbRetainOp(op({ op: 'link.create', body: { from_task_id: 't_a', to_task_id: 't_b', link_type: 'blocks' } }), { kind: 'rejected', status: 400, message: 'm' });
    expect(rebaseView((await idbGetRetainedOps())[1]!, [])).toEqual({ kind: 'plain' });
  });

  test('retrying selected fields queues only those; none selected just discards', async () => {
    const r = await seed();
    await retryRebased(r.id!, ['title']);
    expect(await idbGetPendingOps()).toMatchObject([{ op: 'task.update', taskId: 't_abc001', body: { title: 'Mine' }, attempts: 0 }]);
    expect(await idbGetRetainedOps()).toEqual([]);
    const r2 = await seed();
    await retryRebased(r2.id!, []);
    expect(await idbGetPendingOps()).toHaveLength(1);
    expect(await idbGetRetainedOps()).toEqual([]);
  });
});
