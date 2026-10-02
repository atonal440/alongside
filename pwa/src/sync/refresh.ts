import type { Project, Task, TaskLink } from '../types';
import type { ApiConfig } from '../api/client';
import { idbGetPendingOps } from '../idb/pendingOps';
import { idbReplaceView } from '../idb/view';
import { pullWorkspace } from './pull';
import { overlayPendingOps } from './overlay';

export interface RefreshResult {
  online: boolean;
  tasks?: Task[];
  projects?: Project[];
  links?: TaskLink[];
}

/**
 * The read path: bring the canonical store current, replay the pending-op queue on top,
 * and write the result to the mirror the UI reads. Offline or failed pulls leave the
 * mirror (and the user's optimistic edits) exactly as they were. Because queued ops are
 * replayed every time, an offline-created task or edit survives a refresh by construction.
 */
export async function refreshFromCanonical(config: ApiConfig): Promise<RefreshResult> {
  const outcome = await pullWorkspace(config, { fresh: true });
  if (outcome.kind === 'failed') return { online: false };
  try {
    const view = overlayPendingOps(outcome.workspace, await idbGetPendingOps());
    await idbReplaceView(view);
    return { online: true, tasks: view.tasks, projects: view.projects, links: view.links };
  } catch (error) {
    console.warn('[sync] could not apply the canonical view', error);
    return { online: false };
  }
}
