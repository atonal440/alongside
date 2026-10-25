import type { Project, Task, TaskLink } from '../types';
import type { ApiConfig } from '../api/client';
import { idbClearLandedOps, idbGetLandedOps } from '../idb/landedOps';
import { opsAhead } from './ledger';
import { pullWorkspace } from './pull';
import { overlayPendingOps } from './overlay';

export interface RefreshResult {
  online: boolean;
  tasks?: Task[];
  projects?: Project[];
  links?: TaskLink[];
}

/**
 * The read path: bring the canonical store current and replay the pending-op queue on top.
 * Offline or failed pulls report offline and change nothing stored. Because queued ops are
 * replayed every time, an offline-created task or edit survives a refresh by construction.
 */
export async function refreshFromCanonical(config: ApiConfig): Promise<RefreshResult> {
  // Only commands that landed before this pull began are certain to be in what it returns; one that
  // lands while it runs (a second cycle's flush) waits for the next pull.
  const absorbable = (await idbGetLandedOps()).flatMap(op => (op.id === undefined ? [] : [op.id]));
  const outcome = await pullWorkspace(config, { fresh: true });
  if (outcome.kind === 'failed') return { online: false };
  try {
    await idbClearLandedOps(absorbable);
    const view = overlayPendingOps(outcome.workspace, await opsAhead());
    return { online: true, tasks: view.tasks, projects: view.projects, links: view.links };
  } catch (error) {
    console.warn('[sync] could not build the canonical view', error);
    return { online: false };
  }
}
