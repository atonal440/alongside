import { describe, expect, it, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { resetIdb } from '../helpers/idb';
import { closeDb, getDB } from '../../src/idb/db';
import { idbQueueOp, idbGetPendingOps } from '../../src/idb/pendingOps';
import { idbLandOp, idbGetLandedOps, idbClearLandedOps } from '../../src/idb/landedOps';
import { opsAhead } from '../../src/sync/ledger';

beforeEach(async () => { closeDb(); await resetIdb(); });

const at = (revision: number) => ({ entities: new Map([['task:t_abc001', { revision } as never]]) });
const land = async (commandId: string, revisions: Record<string, number> | null = { 'task:t_abc001': 2 }) => {
  await idbQueueOp({ op: 'command', commandId, intent: { kind: 'task.reopen', id: 't_abc001' }, base: 1 });
  const op = (await idbGetPendingOps()).find(o => o.op === 'command' && o.commandId === commandId)!;
  await idbLandOp(op, revisions);
  return op.id!;
};
const ids = (ops: { op?: { commandId?: string }; commandId?: string }[]) => ops.map(o => o.commandId ?? o.op?.commandId);

describe('landed ledger', () => {
  it('landing moves the op out of the queue in one step', async () => {
    await land('c_one0001');
    expect(await idbGetPendingOps()).toEqual([]);
    expect(ids(await idbGetLandedOps() as never)).toEqual(['c_one0001']);
  });

  it('lists landed commands before the queue until canonical reaches the revision they were given', async () => {
    await land('c_one0001');
    await idbQueueOp({ op: 'command', commandId: 'c_two0002', intent: { kind: 'task.delete', id: 't_abc001' }, base: 2 });
    expect(ids(await opsAhead(at(1)) as never)).toEqual(['c_one0001', 'c_two0002']);
    expect(ids(await opsAhead(null) as never)).toEqual(['c_one0001', 'c_two0002']);
    expect(ids(await opsAhead(at(2)) as never)).toEqual(['c_two0002']);
    expect(ids(await opsAhead(at(5)) as never)).toEqual(['c_two0002']);
    expect(ids(await opsAhead({ entities: new Map() }) as never)).toEqual(['c_one0001', 'c_two0002']);
  });

  it('a command whose response was unreadable is kept until the ledger is cleared', async () => {
    await land('c_one0001', null);
    expect(ids(await opsAhead(at(99)) as never)).toEqual(['c_one0001']);
    await idbClearLandedOps();
    expect(await opsAhead(at(99))).toEqual([]);
  });

  it('clears only the entries it is told about', async () => {
    const first = await land('c_one0001');
    await land('c_two0002');
    await idbClearLandedOps([first]);
    expect(ids(await opsAhead(at(1)) as never)).toEqual(['c_two0002']);
  });

  it('skips a malformed record and reads malformed revisions as unprovable', async () => {
    await land('c_one0001');
    const db = await getDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('landed_ops', 'readwrite');
      tx.objectStore('landed_ops').put({ id: 99, op: 'command', nonsense: true });
      tx.objectStore('landed_ops').put({ id: 98, op: { op: 'command', commandId: 'c_bad0001', intent: { kind: 'task.reopen', id: 't_abc001' }, base: 1, created_at: 'x', attempts: 0 }, revisions: { 'task:t_abc001': 'two' } });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    const landed = await idbGetLandedOps();
    expect(landed.map(l => l.op.op === 'command' ? l.op.commandId : '')).toEqual(['c_one0001', 'c_bad0001']);
    expect(landed[1]!.revisions).toBeNull();
    expect(ids(await opsAhead(at(2)) as never)).toEqual(['c_bad0001']);
  });
});
