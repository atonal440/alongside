import { api } from '../api/endpoints';
import type { ApiConfig } from '../api/client';
import type { ApiResult } from '../api/result';
import type { WorkspaceDelta } from '@shared/wire/sync';
import { applyStagedPull, canonicalFromSnapshot, changedImages, type CanonicalWorkspace } from './canonical';
import { idbCommitCanonical, idbReadCanonical, idbReplaceCanonical } from '../idb/canonical';

const PAGE_LIMIT = 500;
/** Bound a pull so a misbehaving server cannot hold the client in an endless continuation. */
const MAX_PAGES = 1_000;

export type PullOutcome =
  | { kind: 'bootstrapped'; workspace: CanonicalWorkspace; reason: 'first_pull' | 'sync_reset' | 'inconsistent' }
  | { kind: 'updated'; workspace: CanonicalWorkspace }
  | { kind: 'unchanged'; workspace: CanonicalWorkspace }
  | { kind: 'failed'; result: ApiResult<unknown> | { kind: 'inconsistent'; message: string } };

const isSyncReset = (result: ApiResult<unknown>): boolean =>
  result.kind === 'http' && result.status === 409 && result.body.contractError?.syncReset !== undefined;

let inFlight: Promise<PullOutcome> | null = null;

/**
 * Bring the canonical store current with the server. Pages are staged in memory
 * and committed in one IDB transaction, so a failed, reset or inconsistent pull
 * never leaves a half-applied workspace. Resets and inconsistent pulls fall back
 * to one fresh snapshot bootstrap; transient failures leave stored state untouched
 * and are reported for the caller's retry policy. Concurrent calls share one pull.
 */
export function pullWorkspace(config: ApiConfig): Promise<PullOutcome> {
  inFlight ??= run(config).finally(() => { inFlight = null; });
  return inFlight;
}

async function bootstrap(config: ApiConfig, reason: 'first_pull' | 'sync_reset' | 'inconsistent'): Promise<PullOutcome> {
  const snapshot = await api.workspaceSnapshot(config);
  if (snapshot.kind !== 'ok') return { kind: 'failed', result: snapshot };
  const workspace = canonicalFromSnapshot(snapshot.value);
  await idbReplaceCanonical(workspace);
  return { kind: 'bootstrapped', workspace, reason };
}

async function run(config: ApiConfig): Promise<PullOutcome> {
  const base = await idbReadCanonical();
  if (!base) return bootstrap(config, 'first_pull');

  const pages: WorkspaceDelta[] = [];
  let cursor = base.cursor;
  while (pages.length < MAX_PAGES) {
    const first = pages[0];
    const page = await api.workspaceDelta({ cursor, ...(first ? { watermark: first.watermark } : {}), limit: PAGE_LIMIT }, config);
    if (page.kind !== 'ok') return isSyncReset(page) ? bootstrap(config, 'sync_reset') : { kind: 'failed', result: page };
    pages.push(page.value);
    if (!page.value.hasMore) break;
    cursor = page.value.cursor;
  }
  if (pages[pages.length - 1]?.hasMore !== false) return { kind: 'failed', result: { kind: 'inconsistent', message: 'Pull exceeded the page bound.' } };

  const next = applyStagedPull(base, pages);
  if (!next.ok) return bootstrap(config, 'inconsistent');
  const changed = changedImages(base, next.value);
  if (changed.length === 0 && next.value.cursor.sequence === base.cursor.sequence) return { kind: 'unchanged', workspace: base };
  await idbCommitCanonical(next.value, changed);
  return { kind: 'updated', workspace: next.value };
}
