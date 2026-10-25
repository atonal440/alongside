import { describe, expect, it, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { resetIdb } from '../helpers/idb';
import { closeDb, getDB } from '../../src/idb/db';
import { idbQueueOp, idbGetPendingOps } from '../../src/idb/pendingOps';
import { idbLandOp, idbGetLandedOps, idbClearLandedOps } from '../../src/idb/landedOps';
import { opsAhead } from '../../src/sync/ledger';

beforeEach(async () => { closeDb(); await resetIdb(); });

const land = async (commandId: string) => {
  await idbQueueOp({ op: 'command', commandId, intent: { kind: 'task.reopen', id: 't_abc001' }, base: 1 });
  const op = (await idbGetPendingOps()).find(o => o.op === 'command' && o.commandId === commandId)!;
  await idbLandOp(op);
  return op.id!;
};
const ids = (ops: Awaited<ReturnType<typeof opsAhead>>) => ops.map(o => (o.op === 'command' ? o.commandId : o.op));

describe('landed ledger', () => {
  it('landing moves the op out of the queue in one step', async () => {
    await land('c_one0001');
    expect(await idbGetPendingOps()).toEqual([]);
    expect(ids(await idbGetLandedOps())).toEqual(['c_one0001']);
  });

  it('lists landed commands before the queue', async () => {
    await land('c_one0001');
    await idbQueueOp({ op: 'command', commandId: 'c_two0002', intent: { kind: 'task.delete', id: 't_abc001' }, base: 2 });
    expect(ids(await opsAhead())).toEqual(['c_one0001', 'c_two0002']);
  });

  it('clears only the entries it is told about, or everything without a list', async () => {
    const first = await land('c_one0001');
    await land('c_two0002');
    await idbClearLandedOps([first]);
    expect(ids(await opsAhead())).toEqual(['c_two0002']);
    await idbClearLandedOps();
    expect(await opsAhead()).toEqual([]);
  });

  it('skips a malformed ledger record instead of failing the read', async () => {
    await land('c_one0001');
    const db = await getDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('landed_ops', 'readwrite');
      tx.objectStore('landed_ops').put({ id: 99, op: 'command', nonsense: true });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    expect(ids(await opsAhead())).toEqual(['c_one0001']);
  });
});
