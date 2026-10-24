---
tags: [android, sync]
---

# Android sync

The Android app uses the PWA's sync design, not a variant of it: a canonical copy of the server's
workspace, a queue of guarded v2 commands, retained refusals, and a view that replays the queue on
the canonical copy. [Canonical workspace](../pwa/sync/canonical-workspace.md) explains the why; this
note covers how the Kotlin port maps onto it and where it deliberately differs. The code is
`app/.../data/sync/`; `Repository` is a thin Android wrapper over `SyncEngine`.

## Model

| Piece | PWA | Android |
| --- | --- | --- |
| Canonical workspace | IDB `canonical_entities` + `canonical_meta` | `canonical.json` (`CanonicalFile`): cursor + one `SyncImage` per identity |
| Pull | `pullWorkspace`: snapshot, or fixed-watermark delta pages, staged then committed | `SyncEngine.pull`: same, 500 per page, 1,000-page bound |
| Reset | 409 `syncReset`, failed reconciliation or backlog → one snapshot | same (`ResetRequired`) |
| Queue | IDB `pending_ops` | `sync_state.json` (`SyncState.queue`) |
| Command | `commandId` + `Intent` + `base` + saved `sent` envelope | `QueuedOp`, same fields |
| Retained refusals | IDB `retained_ops` | `SyncState.retained` |
| View | `overlayPendingOps(canonical, queue)` | `overlay(canonical.view, landed + queue)` |

Every write is `SyncEngine.commit(intents)`: each intent becomes one queued command whose `base` is
`predictBase` (canonical revision plus the commands ahead of it that write the same identity).
Nothing a screen does touches the network. `SyncEngine.sync()` runs one cycle, single-flight:
`flush` the queue in order, then `pull`, then publish the view.

## Sending

`send` is the PWA's `sendCommand`: read the target (`POST /api/v2/entity`) for its row and the
structural revision, build the envelope (`Envelope.kt`, a port of `envelope.ts`), **save it on the
op before the first send**, and resend exactly that payload under the same command id on any retry.
A lost response is therefore replayed from the server's receipt, never applied twice. Only a
`structural_conflict` (nothing was applied) discards the saved envelope and rebuilds once.

Outcomes follow `docs/pwa/api/sync.md`:

- 2xx: the command leaves the queue.
- Durable 4xx (not 401/403/408/426/429): retained as `Rejected`, or `Conflict` for
  `revision_conflict` (with the server's current revision). A refused create also retains the
  commands queued on its task as `Dependency`.
- Network error, 5xx, auth, rate limit, upgrade-required, unreadable reply: the command stays
  queued, its attempt count goes up and the flush stops, so order is preserved. Nothing is dropped
  or set aside on the number of failures; at 25 attempts the person is told once that changes are
  not getting through.

A cycle that stops early does not pull. A send whose reply was lost (a gateway 502 after the worker
committed) is unresolved, and pulling would absorb its effect into the canonical copy while it is
still queued, so the next write's predicted revision would count it twice. The next cycle replays it
from the saved envelope, clears the queue, then pulls. (The PWA pulls regardless and has that gap.)

Retrying a retained command (Settings → "Try again") queues a *new* command with a fresh id and a
`base` predicted from the workspace as it is now, which is what turns a conflict into a rebase.
Discard forgets it.

## The `landed` list

Between the server accepting a command and the next pull absorbing it, the canonical copy is
behind. A command is moved from the queue to `SyncState.landed` when it succeeds, and stays
there until a pull completes. The view and `predictBase` both count `landed + queue`, so a task
doesn't flicker back to its old state after a tap, and a write made in that window is guarded by the
right revision. It is stored with the queue, so a restart in the window is also safe.

## What is kept

The snapshot and delta carry every entity; the app keeps tasks, projects, links and duties and
drops planning settings, preferences, the action log and command audit (never read here, and the
last two only grow). The cursor still advances past them, and the canonical file is only rewritten
when something the app keeps changed or a snapshot was taken.

## Sample mode

Sample mode builds the canonical copy from `SampleData` in memory (revision 1 per identity) and
queues writes as usual, but has no server, so nothing is sent. Switching server, token or sample
mode calls `SyncEngine.reset`, which bumps a generation counter, clears the stored files and makes
any in-flight work from the old source give up.

## Differences from the PWA

- Intents cover what the screens can do today: create, project, due date, defer, focus, reopen,
  complete, delete. Content, type and link intents come with the screens that make them.
- Retained commands are reviewed as a group (Try again / Discard), not field by field, so there is
  no rebase *review*; retrying already rebases onto the current revision.
- One process owns the files, so there is no cross-tab stale-commit handling.
- Hierarchy invariants (loops, depth) are the worker's to enforce; only references are checked.
- It announces itself with `X-Alongside-Client: android/1`; the PWA's version gate ignores other
  client names.
- Files from the earlier legacy-endpoint queue (`workspace.json`, `pending_ops.json`,
  `set_aside_ops.json`) are deleted on first start; that build never shipped.

## Tests

`SyncEngineTest` drives the engine against `FakeServer`, an in-memory worker with revisions, a
change log, receipts and injectable failures: bootstrap and delta, offline writes, lost-response
replay, 5xx halts, revision conflicts and rebase, refused creates, structural conflicts, recurring
completion with undo, sync reset, restart and source switch.
