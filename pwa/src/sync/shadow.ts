import type { Task, TaskLink } from '../types';
import type { ApiConfig } from '../api/client';
import { idbGetPendingOps } from '../idb/pendingOps';
import { pullWorkspace, type PullOutcome } from './pull';
import { overlayPendingOps } from './overlay';

/**
 * Shadow mode for the canonical read path: keep the canonical store current and check that
 * "canonical + pending ops" agrees with what the legacy sync put on screen. Nothing here
 * changes UI state; it exists so the cut-over can be made once divergences are understood.
 */
const COMPARED = ['title', 'status', 'project_id'] as const;

export function compareToLegacy(view: { tasks: readonly Task[]; links: readonly TaskLink[] }, legacy: { tasks: readonly Task[]; links: readonly TaskLink[] }): string[] {
  const out: string[] = [];
  const mine = new Map(view.tasks.map(t => [t.id, t]));
  const theirs = new Map(legacy.tasks.map(t => [t.id, t]));
  for (const id of mine.keys()) if (!theirs.has(id)) out.push(`task ${id} only in canonical view`);
  for (const [id, task] of theirs) {
    const other = mine.get(id);
    if (!other) { out.push(`task ${id} only in legacy state`); continue; }
    for (const field of COMPARED) if (other[field] !== task[field]) out.push(`task ${id} ${field}: canonical ${JSON.stringify(other[field])} vs legacy ${JSON.stringify(task[field])}`);
  }
  const key = (l: TaskLink) => `${l.from_task_id}>${l.to_task_id}:${l.link_type}`;
  const mineLinks = new Set(view.links.map(key));
  const theirLinks = new Set(legacy.links.map(key));
  for (const k of mineLinks) if (!theirLinks.has(k)) out.push(`link ${k} only in canonical view`);
  for (const k of theirLinks) if (!mineLinks.has(k)) out.push(`link ${k} only in legacy state`);
  return out;
}

export interface ShadowResult { outcome: PullOutcome; divergences: string[] }

/** Never throws: any failure is reported through the outcome and leaves legacy behaviour untouched. */
export async function shadowSync(config: ApiConfig, legacy: { tasks: readonly Task[]; links: readonly TaskLink[] }): Promise<ShadowResult> {
  const outcome = await pullWorkspace(config, { fresh: true });
  if (outcome.kind === 'failed') return { outcome, divergences: [] };
  try {
    const view = overlayPendingOps(outcome.workspace, await idbGetPendingOps());
    return { outcome, divergences: compareToLegacy(view, legacy) };
  } catch (error) {
    return { outcome: { kind: 'failed', result: { kind: 'storage', message: error instanceof Error ? error.message : String(error) } }, divergences: [] };
  }
}
