# Canonical workspace and staged pulls

Slice 2f's first increment gives the PWA a durable copy of the server's committed
workspace, separate from the legacy `tasks`/`projects`/`links` stores and the
pending-op queue. Nothing in the UI or the legacy sync flush reads it yet; later
increments overlay ordered optimistic commands on top of it.

## What is stored

IDB version 5 adds two stores. `canonical_entities` holds one versioned `SyncEntity`
image per identity (`task:t_…`, `link:["t_a","t_b","blocks"]`, `planning_settings:workspace`,
…), live rows and retained tombstones alike. `canonical_meta` holds the cursor
(`{epoch, sequence}`) the images are current through and the structural revision from
the last bootstrap. The delta contract does not carry a structural revision, so it is
only as fresh as the last snapshot.

The store is a **derived cache**. `idbReadCanonical` parses every record through the
shared sync schemas and verifies identity keys and live references; anything corrupt,
partial or dangling reads as "no canonical state" (with a console warning) instead of
being repaired in place, and the next pull re-bootstraps. The v4→v5 upgrade only adds
stores, so existing tasks and queued ops are untouched.

## Reconciling a pull

`pullWorkspace(config)` (in `pwa/src/sync/pull.ts`) is the only writer:

1. No stored state → fetch a snapshot and replace the store in one transaction.
2. Otherwise request delta pages from the stored cursor. The first page omits the
   watermark; every continuation sends the latest returned cursor and the first
   page's watermark, with a page limit of 500 and a hard page bound.
3. Pages are staged in memory. `applyStagedPull` (pure, in `pwa/src/sync/canonical.ts`)
   requires each page to start exactly where the previous one ended in the same epoch,
   the watermark to stay fixed, the last page to have `hasMore:false`, and every
   image's revision to be strictly above the stored revision for its identity. Only
   after all pages are applied does it check that live references resolve, since a
   page may split a source transaction.
4. Success commits only the changed images plus the new cursor in a single IDB
   transaction (`unchanged` when nothing moved).

Failure handling keeps stored state intact. Network, auth, rate-limit and 5xx
failures return `{kind:'failed', result}` for the caller's existing retry policy.
HTTP 409 with `syncReset` diagnostics (epoch change, expired history, impossible
cursor) triggers one fresh bootstrap that replaces the old epoch wholesale. A staged
pull that fails reconciliation (revision regression, gap, moved watermark, dangling
final state) also falls back to one bootstrap rather than committing a guess. Other
409s are not treated as resets. Concurrent callers share one in-flight pull.

## Out of scope for this increment

Wiring the canonical store into reducer/UI state, overlaying pending commands,
retained conflicts and inspectable rebase, version negotiation and the capability
gate remain later 2f increments. The legacy queue and `syncFromServer` are unchanged.
