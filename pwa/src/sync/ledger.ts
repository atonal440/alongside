import type { PendingOp } from '../api/pendingOps';
import { idbReadLedgerAndQueue } from '../idb/landedOps';

/**
 * Everything the canonical copy does not reflect yet, oldest first: commands the server accepted that no
 * pull has absorbed (the landed ledger), then the queue. The view replays this on canonical and
 * `predictBase` counts it, so an accepted command neither vanishes from the screen nor is forgotten by
 * the revision guard of the next write while a halted flush keeps the pull from running.
 *
 * `refreshFromCanonical` clears the ledger entries that had landed before its pull began. A crash
 * between that pull's commit and the clear leaves them counted twice until the next successful pull,
 * which can retain one edit as a false conflict; it is retried from Needs attention.
 */
export async function opsAhead(): Promise<PendingOp[]> {
  const { landed, queue } = await idbReadLedgerAndQueue();
  return [...landed, ...queue];
}
