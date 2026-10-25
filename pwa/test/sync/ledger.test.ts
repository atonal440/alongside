import { describe, expect, it, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { resetIdb } from '../helpers/idb';
import { closeDb } from '../../src/idb/db';
import { idbQueueOp, idbGetPendingOps } from '../../src/idb/pendingOps';
import { idbLandOp, idbGetLandedOps, idbClearLandedOps } from '../../src/idb/landedOps';
import { opsAhead } from '../../src/sync/ledger';

beforeEach(async () => { closeDb(); await resetIdb(); });

const land = async (commandId: string, landedAt: { epoch: number; sequence: number } | null) => {
  await idbQueueOp({ op: 'command', commandId, intent: { kind: 'task.reopen', id: 't_abc001' }, base: 1 });
  const op = (await idbGetPendingOps()).find(o => o.op === 'command' && o.commandId === commandId)!;
  await idbLandOp(op, landedAt);
};
const ids = (ops: Awaited<ReturnType<typeof opsAhead>>) => ops.map(o => (o.op === 'command' ? o.commandId : o.op));
const at = (epoch: number, sequence: number) => ({ cursor: { epoch, sequence } as never });

describe('landed ledger', () => {
  it('landing moves the op out of the queue in one step', async () => {
    await land('c_one0001', { epoch: 1, sequence: 5 });
    expect(await idbGetPendingOps()).toEqual([]);
    expect(ids((await idbGetLandedOps()).map(l => l.op))).toEqual(['c_one0001']);
  });

  it('lists landed commands before the queue until the canonical cursor moves past where they landed', async () => {
    await land('c_one0001', { epoch: 1, sequence: 5 });
    await idbQueueOp({ op: 'command', commandId: 'c_two0002', intent: { kind: 'task.delete', id: 't_abc001' }, base: 2 });
    expect(ids(await opsAhead(at(1, 5)))).toEqual(['c_one0001', 'c_two0002']);
    expect(ids(await opsAhead(null))).toEqual(['c_one0001', 'c_two0002']);
    expect(ids(await opsAhead(at(1, 6)))).toEqual(['c_two0002']);
    expect(ids(await opsAhead(at(2, 0)))).toEqual(['c_two0002']);
  });

  it('a command that landed with no canonical copy is kept until the ledger is cleared', async () => {
    await land('c_one0001', null);
    expect(ids(await opsAhead(at(9, 99)))).toEqual(['c_one0001']);
    await idbClearLandedOps();
    expect(await opsAhead(at(9, 99))).toEqual([]);
  });
});
