import type { PendingOp } from '../api/pendingOps';
import { idbGetPendingOps } from '../idb/pendingOps';
import { idbGetLandedOps } from '../idb/landedOps';
import type { SyncCursor } from '@shared/wire/sync';

/**
 * Everything the canonical copy does not reflect yet, oldest first: commands the server accepted that no
 * pull has absorbed (the landed ledger), then the queue. The view replays this on canonical and
 * `predictBase` counts it, so an accepted command neither vanishes from the screen nor is forgotten by
 * the revision guard of the next write while a halted flush keeps the pull from running.
 *
 * A landed command counts as absorbed once the canonical cursor is past the one it landed at (or in a
 * later epoch); that covers a crash between a pull's commit and the ledger being cleared.
 */
export async function opsAhead(canonical: object | null): Promise<PendingOp[]> {
  const cursor = canonical && 'cursor' in canonical ? canonical.cursor as SyncCursor : undefined;
  const landed = (await idbGetLandedOps())
    .filter(({ landedAt }) => !(cursor && landedAt && (cursor.epoch !== landedAt.epoch || cursor.sequence > landedAt.sequence)))
    .map(({ op }) => op);
  return [...landed, ...await idbGetPendingOps()];
}
