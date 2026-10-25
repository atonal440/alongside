import type { Project, Task, TaskLink } from '../types';
import type { ApiConfig } from '../api/client';
import { idbClearLandedOps, idbGetLandedOps } from '../idb/landedOps';
import { isAbsorbed, opsAhead } from './ledger';
import { currentWorkspace } from './pull';
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
  // Ledger entries are tidied one pull late: only those the canonical copy as it stood *before* this pull
  // already showed. A reader holding an older canonical read then still finds the entry it needs.
  const before = await currentWorkspace(config.apiBase);
  const tidy = (await idbGetLandedOps()).filter(entry => isAbsorbed(entry, before)).flatMap(({ op }) => (op.id === undefined ? [] : [op.id]));
  const outcome = await pullWorkspace(config, { fresh: true });
  if (outcome.kind === 'failed') return { online: false };
  try {
    await idbClearLandedOps(tidy);
    const view = overlayPendingOps(outcome.workspace, await opsAhead(outcome.workspace));
    return { online: true, tasks: view.tasks, projects: view.projects, links: view.links };
  } catch (error) {
    console.warn('[sync] could not build the canonical view', error);
    return { online: false };
  }
}
