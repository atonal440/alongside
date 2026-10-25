import type { PendingOp } from '../api/pendingOps';
import type { CanonicalWorkspace } from './canonical';
import { idbReadLedgerAndQueue, type LandedOp } from '../idb/landedOps';

type Canonical = Pick<CanonicalWorkspace, 'entities'>;

/**
 * Whether canonical already reflects an accepted command: every identity it wrote is at (or past) the
 * revision the server gave it. Revisions only grow, so this is exact and stateless: a pull that ran
 * while the command landed, a crash before the ledger was tidied, or a concurrent cycle cannot make the
 * command count twice or vanish. A command whose response was unreadable can't be proven absorbed.
 */
export function isAbsorbed({ revisions }: LandedOp, canonical: Canonical | null): boolean {
  if (revisions === null || canonical === null) return false;
  return Object.entries(revisions).every(([identity, revision]) => (canonical.entities.get(identity)?.revision ?? 0) >= revision);
}

/**
 * Everything the canonical copy does not reflect yet, oldest first: commands the server accepted that
 * canonical has not caught up to (the landed ledger), then the queue. The view replays this on canonical
 * and `predictBase` counts it, so an accepted command neither vanishes from the screen nor is forgotten
 * by the revision guard of the next write while a halted flush keeps the pull from running.
 */
export async function opsAhead(canonical: Canonical | null): Promise<PendingOp[]> {
  const { landed, queue } = await idbReadLedgerAndQueue();
  return [...landed.filter(entry => !isAbsorbed(entry, canonical)).map(entry => entry.op), ...queue];
}
