import { currentWorkspace } from './pull';
import { overlayPendingOps, type OverlayView } from './overlay';
import type { CanonicalWorkspace } from './canonical';
import { opsAhead } from './ledger';

const EMPTY: Pick<CanonicalWorkspace, 'entities'> = { entities: new Map() };

/**
 * What the UI shows right now, without the network: the stored canonical workspace (empty before
 * the first pull) with every pending op replayed on top. Used for the initial load and after each
 * optimistic write; `refreshFromCanonical` produces the same shape after a pull.
 */
export async function loadView(source: string): Promise<OverlayView> {
  const stored = await currentWorkspace(source);
  return overlayPendingOps(stored ?? EMPTY, await opsAhead(stored));
}
