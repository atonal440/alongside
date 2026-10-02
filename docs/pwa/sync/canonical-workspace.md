# Canonical workspace and staged pulls

Slice 2f's first increment gives the PWA a durable copy of the server's committed
workspace, separate from the legacy `tasks`/`projects`/`links` stores and the
pending-op queue. Nothing in the UI or the legacy sync flush reads it yet; later
increments overlay ordered optimistic commands on top of it.

## What is stored

IDB version 5 adds two stores. `canonical_entities` holds one versioned `SyncEntity`
image per identity (`task:t_…`, `link:["t_a","t_b","blocks"]`, `planning_settings:workspace`,
…), live rows and retained tombstones alike. `canonical_meta` holds the cursor
(`{epoch, sequence}`) the images are current through and the `source` (API base) they
came from. A cache written for another server reads as a miss. The structural revision
is deliberately not stored: the delta contract never refreshes it, so any copy would be
stale after the first write; read it with an entity-version lookup when needed.

The store is a **derived cache**. `idbReadCanonical` parses every record through the
shared sync schemas and verifies identity keys and live references; anything corrupt,
partial, dangling or from another server reads as "no canonical state" (with a console
warning naming the problem) instead of being repaired in place, and the next pull
re-bootstraps. All writes are single transactions that abort as a whole on any failure,
including a synchronous put error, so a partial store cannot be committed. Logout clears
the store with the rest of the local data.

The v4→v5 upgrade only adds stores, so existing tasks and queued ops are untouched. An
open connection closes itself on `versionchange`, so a newer tab can upgrade instead of
hanging behind it (tabs running pre-v5 code cannot do this and must be closed once).

## Reconciling a pull

`pullWorkspace(config)` (in `pwa/src/sync/pull.ts`) is the only writer:

1. No stored state → fetch a snapshot and replace the store in one transaction. An
   unreadable store is reported as the `cache_invalid` bootstrap reason.
2. Otherwise request delta pages from the stored cursor. The first page omits the
   watermark; every continuation sends the latest returned cursor and the first
   page's watermark, with a page limit of 500 and a page bound of 1,000 (a backlog
   past the bound bootstraps from a snapshot, which is cheaper than replaying it).
3. Pages are staged in memory. `applyStagedPull` (pure, in `pwa/src/sync/canonical.ts`)
   requires each page to start exactly where the previous one ended in the same epoch,
   the watermark to stay fixed, the last page to have `hasMore:false`, and every
   image's revision to be strictly above the stored revision for its identity. Only
   after all pages are applied does it check that live references resolve
   (`findDanglingReference`, shared with the snapshot schema), since a page may split a
   source transaction.
4. Success commits only the changed images plus the new cursor in a single IDB
   transaction that first compares the stored cursor with the one the pull started from.
   If another tab committed in between, the commit writes nothing and the pull is
   reconciled once against the new state (`unchanged` when nothing moved).

The tab keeps the last validated workspace in memory and checks only the stored cursor
to decide whether it is still current, so unchanged polls do not re-parse the store.

Failure handling keeps stored state intact. Network, auth, rate-limit and 5xx
failures return `{kind:'failed', result}` for the caller's existing retry policy, and
storage errors return `{kind:'failed', result:{kind:'storage'}}` rather than rejecting.
HTTP 409 with `syncReset` diagnostics (epoch change, expired history, impossible
cursor) triggers one fresh bootstrap that replaces the old epoch wholesale. A staged
pull that fails reconciliation (revision regression, gap, moved watermark, dangling
final state) logs the reason and also falls back to one bootstrap rather than
committing a guess. Other 409s are not treated as resets. Concurrent callers with the
same credentials share one in-flight pull; pass `{fresh:true}` after your own write to
run a pull that starts after the in-flight one, and different credentials never share.

## Overlaying pending commands

`overlayPendingOps(canonical, ops)` (`pwa/src/sync/overlay.ts`) is the pure projection the
UI will read: canonical live tasks, projects and links with the queued ops replayed in
queue order. It reuses the local mutation rules (`applyUpdate`, `applyComplete`), never
mutates its inputs, and never throws. An op that cannot apply to the current state (task
gone, duplicate create, invalid edit, missing link endpoint) is skipped and reported in
`outcomes[i]` with a reason, and later ops still run. That reporting is the hook for the
retained-conflict and rebase work: nothing here drops or rewrites the queue.

## Retained failed intent

IDB v6 adds a `retained_ops` store. When the legacy flush hits a durable 4xx (including
409), the op is written there with `{kind:'rejected', status, message}` *before* it leaves
the queue, so the user's intended change is no longer lost; a refused `task.create` also
retains its queued dependents as `{kind:'dependency', dependsOn}`, in queue order.
Retained ops never flush again and are not overlaid. Auth/429/network/5xx stay retryable
and are never retained. Reads parse each record (`parseRetainedOp`, embedding
`parsePendingOp`) and skip malformed ones with a warning; logout clears the store. The
toast and resync behaviour is unchanged.

The sidebar's "Needs attention" list (`RetainedOps`) shows each retained op with its
reason. **Retry** (`retryRetainedOp`) re-queues the op with fresh attempts and requests a
sync; retrying a refused create re-queues it together with the dependents retained
because of it, in original order, and restores its local placeholder task. **Discard**
abandons the op (and those dependents).

**Review** (refused task edits only) is the inspectable rebase. `rebaseView` diffs the
edit against the task as the app now holds it (already resynced to server truth after the
rejection): each field shows current → intended, and fields the task already has are
disabled. `retryRebased` re-queues an edit containing only the checked fields, or just
discards when none are checked. A target task that no longer exists hides Retry. The
comparison uses the legacy task list; it moves to the canonical overlay when that is wired
into UI state. Retry on other ops stays a plain resubmit.

## The read path

`useSync` flushes the pending-op queue, then calls `refreshFromCanonical`
(`pwa/src/sync/refresh.ts`): `pullWorkspace` (fresh, so it starts after the flush's writes),
`overlayPendingOps` over the result, and `idbReplaceView` writes the derived tasks, projects
and links to the legacy IDB mirror in one transaction. The reducer and the optimistic action
creators still read and write that mirror, so they are unchanged. The old per-collection REST
reads (`/api/tasks/sync`, `/api/projects/sync`, `/api/tasks/links`) are no longer used by the
PWA.

Consequences worth knowing: an offline-created task or edit survives every refresh because its
queued op is replayed, not because a survivor rule protects a local row; a rejected write rolls
back on the next refresh because nothing replays it (it is retained instead); an offline or
failed pull leaves the mirror and the user's edits untouched and reports offline.

`flushPendingOps` is single-flight: overlapping callers (React StrictMode's doubled effects, a
service-worker nudge mid-cycle) share one run, because two concurrent flushes sent the same
queued create twice and duplicated the task.

`npm run e2e` (`scripts/e2e-canonical.mjs`) drives this path in a real browser against a local
worker and PWA: server-created tasks arriving, online add once, offline add surviving a reload
and flushing exactly once, a refused edit retained and discardable, and a server-side delete
propagating. Offline is simulated by blocking the API origin, since the dev server has no service
worker to serve the app shell offline. It needs `playwright` resolvable
(`PLAYWRIGHT_MODULE=/path/to/playwright` to point at one). `npm run e2e:stack` starts the worker
and PWA itself, runs the script and tears both down (after `npm --prefix worker run db:init` and
copying `worker/.dev.vars.example`); it takes about 30 seconds locally. CI runs it as a separate
`E2E sync` job in `checks.yml`, in parallel with the Worker and PWA jobs, with Playwright pinned
and installed outside the repo lockfiles and its browser cached; logs and a failure screenshot
upload as an artifact on failure.

## Version negotiation

Every PWA request carries `X-Alongside-Client: pwa/<protocol>`. The worker answers a write from a
browser that announces nothing or too old a protocol with 426 `upgrade_required` (see the
[API notes](../../api.md#client-protocol-and-the-write-gate)). On the client 426 is classified
transient, so the flush halts with ops kept in the queue (not retained, not dropped), and `useSync`
toasts once per cycle to reload; `consumeUpgradeRequired` carries the signal out of `apiRequest`.
Reads still work, so an old tab keeps showing data. The browser e2e probes the gate directly.

## Out of scope for this increment

Wiring the canonical store and overlay into reducer/UI state,  version negotiation and the capability
gate remain later 2f increments. The legacy queue and `syncFromServer` are unchanged.
