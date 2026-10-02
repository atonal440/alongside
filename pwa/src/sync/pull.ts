import { api } from '../api/endpoints';
import type { ApiConfig } from '../api/client';
import type { ApiResult } from '../api/result';
import type { WorkspaceDelta } from '@shared/wire/sync';
import { applyStagedPull, canonicalFromSnapshot, changedImages, type CanonicalWorkspace } from './canonical';
import { idbCommitCanonical, idbReadCanonical, idbReadCanonicalCursor, idbReplaceCanonical, StaleCanonicalError } from '../idb/canonical';

const PAGE_LIMIT = 500;
/** Bound a pull so a misbehaving server cannot hold the client in an endless continuation. */
const MAX_PAGES = 1_000;

export type BootstrapReason = 'first_pull' | 'cache_invalid' | 'sync_reset' | 'inconsistent' | 'backlog';
export type PullFailure = ApiResult<unknown> | { kind: 'inconsistent' | 'storage'; message: string };
export type PullOutcome =
  | { kind: 'bootstrapped'; workspace: CanonicalWorkspace; reason: BootstrapReason }
  | { kind: 'updated'; workspace: CanonicalWorkspace }
  | { kind: 'unchanged'; workspace: CanonicalWorkspace }
  | { kind: 'failed'; result: PullFailure };

export interface PullOptions {
  /** Start a new pull after any in-flight one instead of sharing its result (use after your own write). */
  fresh?: boolean;
  /** Test seam for the continuation bound. */
  maxPages?: number;
}

const isSyncReset = (result: ApiResult<unknown>): boolean =>
  result.kind === 'http' && result.status === 409 && result.body.contractError?.syncReset !== undefined;

// The last workspace this tab validated. A cheap metadata cursor check decides whether
// it is still current, so unchanged polls skip re-parsing the whole store.
let cache: { source: string; workspace: CanonicalWorkspace } | null = null;
export function resetPullCache(): void { cache = null; }

interface Flight { key: string; promise: Promise<PullOutcome>; trailing: Promise<PullOutcome> | null }
let flight: Flight | null = null;

function start(config: ApiConfig, options: PullOptions): Promise<PullOutcome> {
  const current: Flight = { key: `${config.apiBase}\n${config.authToken}`, promise: run(config, options, true), trailing: null };
  current.promise = current.promise.finally(() => { if (flight === current) flight = null; });
  flight = current;
  return current.promise;
}

/**
 * Bring the canonical store current with the server. Pages are staged in memory
 * and committed in one IDB transaction, so a failed, reset or inconsistent pull
 * never leaves a half-applied workspace. Resets, inconsistent pulls and backlogs
 * beyond the page bound fall back to one fresh snapshot bootstrap; transient
 * failures leave stored state untouched and are reported for the caller's retry
 * policy. Concurrent calls with the same credentials share one pull unless `fresh`
 * asks for a pull that begins after the in-flight one.
 */
export function pullWorkspace(config: ApiConfig, options: PullOptions = {}): Promise<PullOutcome> {
  const key = `${config.apiBase}\n${config.authToken}`;
  if (!flight) return start(config, options);
  if (flight.key === key && !options.fresh) return flight.promise;
  const settled = flight.promise.then(() => undefined, () => undefined);
  if (flight.key === key) return (flight.trailing ??= settled.then(() => start(config, options)));
  return settled.then(() => start(config, options));
}

async function bootstrap(config: ApiConfig, reason: BootstrapReason): Promise<PullOutcome> {
  const snapshot = await api.workspaceSnapshot(config);
  if (snapshot.kind !== 'ok') return { kind: 'failed', result: snapshot };
  const workspace = canonicalFromSnapshot(snapshot.value);
  await idbReplaceCanonical(workspace, config.apiBase);
  cache = { source: config.apiBase, workspace };
  return { kind: 'bootstrapped', workspace, reason: reason };
}

async function run(config: ApiConfig, options: PullOptions, retryStale: boolean): Promise<PullOutcome> {
  try {
    return await pull(config, options, retryStale);
  } catch (error) {
    return { kind: 'failed', result: { kind: 'storage', message: error instanceof Error ? error.message : String(error) } };
  }
}

async function pull(config: ApiConfig, options: PullOptions, retryStale: boolean): Promise<PullOutcome> {
  const source = config.apiBase;
  const storedCursor = await idbReadCanonicalCursor(source);
  if (!storedCursor) return bootstrap(config, 'first_pull');
  let base: CanonicalWorkspace | null = null;
  if (cache?.source === source && cache.workspace.cursor.epoch === storedCursor.epoch && cache.workspace.cursor.sequence === storedCursor.sequence) base = cache.workspace;
  else base = await idbReadCanonical(source);
  if (!base) return bootstrap(config, 'cache_invalid');

  const pages: WorkspaceDelta[] = [];
  let cursor = base.cursor;
  const maxPages = options.maxPages ?? MAX_PAGES;
  while (pages.length < maxPages) {
    const first = pages[0];
    const page = await api.workspaceDelta({ cursor, ...(first ? { watermark: first.watermark } : {}), limit: PAGE_LIMIT }, config);
    if (page.kind !== 'ok') return isSyncReset(page) ? bootstrap(config, 'sync_reset') : { kind: 'failed', result: page };
    pages.push(page.value);
    if (!page.value.hasMore) break;
    cursor = page.value.cursor;
  }
  // A backlog past the bound is cheaper to replace than to replay, and replaying again would never converge.
  if (pages[pages.length - 1]?.hasMore !== false) return bootstrap(config, 'backlog');

  const next = applyStagedPull(base, pages);
  if (!next.ok) {
    console.warn('[sync] staged pull rejected; re-bootstrapping', next.error);
    return bootstrap(config, 'inconsistent');
  }
  const changed = changedImages(base, next.value);
  if (changed.length === 0 && next.value.cursor.sequence === base.cursor.sequence) { cache = { source, workspace: base }; return { kind: 'unchanged', workspace: base }; }
  try {
    await idbCommitCanonical(next.value, changed, source, base.cursor);
  } catch (error) {
    if (!(error instanceof StaleCanonicalError)) throw error;
    // Another tab moved the store first; reconcile against its state once.
    cache = null;
    return retryStale ? pull(config, options, false) : { kind: 'failed', result: { kind: 'inconsistent', message: 'Canonical store kept changing during the pull.' } };
  }
  cache = { source, workspace: next.value };
  return { kind: 'updated', workspace: next.value };
}
