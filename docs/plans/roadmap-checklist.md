# Roadmap checklist

One place for everything still to do. It was compiled on 2026-10-24 from the
plan checklists in this directory, the Android docs, `alongside-ideas.md`, and
the maintainer's saved notes. It does not replace them: each item links to the
document that owns the detail. When an item lands, tick it here and in the
owning checklist.

Legend: **[ ]** open, **[~]** partly done (the note says what is left),
**[x]** done but listed because the owning doc may still read as open.

## Reading the older checklists

- [`power-user-todo-implementation-todo.md`](power-user-todo-implementation-todo.md)
  is the live sequencing doc. Slices 1–2 are done; 3 is under way; 4–7 are open.
- [`duties-implementation-todo.md`](duties-implementation-todo.md) is **stale**.
  Stages 3–10 are unchecked, but the power-user plan told us not to implement
  them unchanged, and recurrence R1–R3 (series engine, duty commands, legacy
  adoption) landed under Slice 6 instead. Treat Stage 3+ boxes as superseded by
  the section "Slice 6" below, not as separate work.
- [`pwa-type-safety-implementation-todo.md`](pwa-type-safety-implementation-todo.md)
  and [`type-driven-safety-implementation-todo.md`](type-driven-safety-implementation-todo.md)
  are finished apart from the leftovers listed under "Loose ends".

## 1. Sync correctness (do before more sync work)

Design against the PWA's canonical-workspace model first
([`docs/pwa/sync/canonical-workspace.md`](../pwa/sync/canonical-workspace.md));
write the model down before coding.

- [x] **PWA: hold later commands on the same identity after a refusal.**
  After a durable refusal (e.g. `revision_conflict`), `flushQueue` keeps going
  and a later command's predicted base can match by coincidence (focus then
  delete a task at rev 1; another device edits it to rev 2; focus conflicts,
  delete's base 2 matches and deletes unseen changes). Retain every later
  command whose `intentWrites` overlap as `{kind:'dependency'}`, as
  `dropDependentOps` already does for a refused create.
- [x] **PWA: skip the pull while a send is unresolved.** After a transient
  failure post-commit (gateway 502/504) the flush halts but
  `refreshFromCanonical` still pulls, absorbing the command into canonical while
  it is still queued; `predictBase` then double counts and the next edit is
  retained as a false conflict. Skip the pull when `flushPendingOps` returns
  `halted`.
  Both fixes: `pwa/src/api/sync.ts` and the sync loop in `pwa/src/hooks`, with
  tests, and update the canonical-workspace doc. The Android fixes are the
  reference (`app/.../data/sync/SyncEngine.kt`, `retain`, `cycle`;
  [`docs/android/sync.md`](../android/sync.md)).
- [x] **Worker: make the snapshot tolerate over-long legacy text.** The worker
  validates its own snapshot, so one row over the cap made
  `/api/v2/sync/snapshot` return 500 and broke sync for both clients (happened
  in production with 7.8k–10k character kickoff notes against the 2,000 cap).
  Caps live in `shared/wire/rows.ts` and only bind new writes. Degrade (clamp,
  skip with a warning, or pass through) instead of failing wholesale.
  Done by passing through: the row schemas now read text up to `ROW_TEXT_READ_MAX`
  (`shared/wire/rows.ts`) while commands, REST and forms keep the real caps. Clamping would
  have truncated the note permanently on the next unrelated edit, since a content command
  resends the row's other text fields. Editing such a task's other fields is refused by the
  write cap (retained for review) until the text is trimmed.
  The v1 import keeps the write caps (`taskRowWriteEntries`, `ProjectRowWriteSchema`); the v2
  export/restore codec reads with the relaxed caps so a backup of such a workspace still restores.
- [~] **Android sync port (#87, branch `android-pwa-sync`).** Engine port and
  its review rounds are committed; confirm the PR is merged, then drop it from
  this list. Its docs ([`android/sync.md`](../android/sync.md)) still say "the
  PWA pulls regardless and has that gap", which becomes false once the PWA items
  above land.

## 2. Notes and long text

- [ ] **Arbitrarily long notes.** Design note first. Compare "raise caps and keep
  inline", "separate lazily fetched body in D1", and "R2 body". Check real
  payload sizes before choosing. Constraints: snapshots and deltas carry every
  row inline, so big notes bloat every bootstrap and each client's canonical
  copy; keep a preview (or length plus revision) inline; bodies need local
  caching and a queued-write path with revision/receipt guards; a new kind or
  `notes_ref` touches sync schemas, delta/snapshot, restore/export, MCP tools and
  both clients. The longest production note is 9,954 of the 10,000 cap.
- [ ] **Rich-text `notes`** and a different treatment for `kickoff_note` vs
  `notes` (`alongside-ideas.md`). Fold into the long-notes design.

## 3. Power-user plan ([master](power-user-todo.md))

### Slice 3 — tasks, hierarchy, dates (started)

Landed: 3a explicit `available_from`/`deadline`, 3b `parent_id`/`position`
subtasks, 3c effective dates and readiness explanations.

- [ ] Reject ancestor/descendant `blocks` links and cycles in the *effective*
  graph (still open).
- [ ] Tags, priority, estimates, chunk policy, waiting reason, richer status and
  terminal timestamps.
- [ ] Group roles/`node_role`, completion policy (`all_children_done`), cancel
  cascade, subtree scope, soft delete and a separate purge. Currently: any task
  may have subtasks, completion is manual and refused while a subtask is open,
  deleting a task with subtasks is refused.
- [ ] Semantic create/subdivide/move/reorder/complete/reopen/cancel/delete
  planners; forbid arbitrary managed-field patches.
- [ ] Cancelled-blocker handling and final-state effective-dependency validation.
- [ ] Bounded task/subtree context through REST/MCP; tags and lifecycle ops.
- [ ] Backfill `due_date` as a target using slice-1 provenance; legacy writers
  update only the target.
- [ ] Export/import, feed/tombstone, IDB, queue, reducer and API parsing for each
  new field.
- [ ] Tests: combined graph cycles, inherited constraints, cross-project moves,
  empty groups, cancel/reopen, ordering, deleted blockers, leaf-only effort
  totals.
- [ ] Update architecture and REST/MCP references as contracts land.

### Slice 4 — timeblocks and deterministic planning

- [ ] Block owner/interval/placement/state constraints, working hours and date
  overrides.
- [ ] Block create/move/swap/cancel with final-agenda validation.
- [ ] Zoned agenda and free-slot search; `preview_schedule` using estimates.
- [ ] Missing-effort assumptions, feasible proposals, coverage reporting.
- [ ] REST/MCP exposure (via `get_agenda`/`preview_schedule` and command kinds,
  not new tools); commit proposed slots as commands.
- [ ] Blocks and settings in export/import, sync, IDB and parsed pending ops.
- [ ] Tests (adjacent/overlapping intervals, swaps, fixed/movable, partial
  failure) plus the calendar phantom checks deferred from Slice 2.

### Slice 5 — reminders and real background delivery

- [ ] Reminder owner/trigger/offset unions, generation/snooze/expiry state.
- [ ] Create/pause/resume/rearm/snooze/acknowledge planners with atomic effects.
- [ ] Persist notification intent with commands; terminal cleanup.
- [ ] Bounded due-work scanning, leases/fencing, capped retries.
- [ ] Scheduled handler and one-minute cron behind a readiness gate.
- [ ] Inbox plus a Worker-compatible Web Push adapter (keep VAPID secrets out of
  export).
- [ ] Reminder/inbox/delivery REST/MCP queries with honest status.
- [ ] Quiet hours and bounded repeating policies.
- [ ] Export intent without credentials/subscriptions/leases.
- [ ] Concurrency/lease/retry tests.
- [ ] Verify one real opted-in device with the app closed; record acceptance.

### Slice 6 — series, occurrences, templates (recurrence)

Landed: R1 series engine (`dutyFromRow`, `materializeDutyPlan`,
`materializeDueDuties`, 15-minute cron, lazy reads), R2 `duty.create`,
`duty.content.set`, `duty.status.set` plus reads, R3 `duty.adopt_task`.

- [ ] **Duties PWA surface** (list/pause/end, "from duty" badge, remove the
  recurrence field from task creation). Replaces old duties Stages 7–8.
- [ ] `series_occurrences` ledger, skip/override/exceptions.
- [ ] Date-profile and after-completion recurrence; completion successors keyed
  by predecessor with explicit cancel/reopen.
- [ ] Template versions, occurrence/node keys, task-graph templates (old duties
  Stage 9), wider occurrence uniqueness before graph spawning.
- [ ] Bounded lookahead including negative reminder/date offsets.
- [ ] Series REST/MCP/aliases, previews/context, export/import/feed.
- [ ] Retire the legacy completion-driven successor path for the records the
  engine cannot yet represent (no or timed due date, rejected rule, COUNT);
  drop the `tasks.recurrence` column (old duties Stage 10).
- [ ] Recurring tasks inherit kickoff notes and other data, or are built from a
  template; support a recurring sequence of blockers (`alongside-ideas.md`).
- [ ] Decide whether to keep or delete legacy `parseRrule`/`nextOccurrence`.
- [ ] Push-notification seam in the scheduled handler (pairs with Slice 5).
- [ ] Reconcile and then archive the old duties work orders.

### Slice 7 — queries, continuity, history, release hardening

- [ ] Saved query ASTs, compound filters, pagination/sorting.
- [ ] Append-only session/progress entries, actual work logs.
- [ ] Revision-guarded undo (`undo_changes`).
- [ ] Portable round-trip, redacted optional history, restore epoch checks.
- [ ] Staged large imports if needed (v1 migration diagnostics also deferred).
- [ ] Runner health: coverage, oldest due item, queue depth, last success.
- [ ] Exercise worked intentions through real REST/MCP on a migrated local DB.
- [ ] Query-plan and bounded-runtime checks.
- [ ] Update `docs/overview.md`, `docs/api.md`, `docs/mcp-tools.md`.
- [ ] Release checks and acceptance evidence.

## 4. MCP surface ([plan](mcp-surface.md))

Phases A–D are built; the default `/mcp` list is 14 tools. Remaining:

- [ ] Add each new Slice 3–7 verb as a command kind, `get_agenda`,
  `preview_schedule` or `undo_changes`, keeping `tools/list` at or below ~20.
- [ ] Settle the open questions when logs allow: one `find` vs per-entity,
  how many quick verbs, admin endpoint vs flag.
- [ ] Make the `start_session` prompt injection more automatic, e.g. on a
  session's first tool use (`alongside-ideas.md`); note `start_session` was
  removed from `/mcp` in phase D, so this needs a rethink first.
- [~] Duty commands exist in the command catalog (R2) but have no quick verb;
  decide if one is warranted.

## 5. Android app ([overview](../android/overview.md))

- [ ] Show and edit duties (Routines only lists repeating tasks today).
- [ ] Edit titles, notes, links and subtasks; project management.
- [ ] Content, type and link intents in the sync engine, with their screens.
- [ ] Field-level rebase review for retained commands (currently group
  Try again / Discard).
- [ ] Ready-now widget chips (blocked by Glance horizontal scrolling).
- [ ] Client-side hierarchy checks (loops, depth) are left to the worker today.

## 6. PWA UI

A full rework is deferred (plans only cover data compatibility).
From `alongside-ideas.md`:

- [ ] Redesign with one distinctive style shared with the MCP app UI.
- [ ] Focus on one or two tasks at a time; avoid big lists (kanban style?).
- [ ] Add context and information to tasks directly.
- [ ] Edit the new date roles, hierarchy and duties (displayed read-only now).

## 7. Loose ends in finished plans

- [ ] `docs/pwa/api/` failure-kind contract doc (PWA type-safety stage 3, unticked).
- [ ] `docs/pwa/idb/` migration history and manual legacy-queue upgrade check
  (stage 4, unticked).
- [ ] Type-driven safety "later slices": MCP typed registry, OAuth/preferences/
  action-log policy, D1 check constraints, cleanup and compiler hardening, and
  removal of the `TaskCreate`/`TaskUpdate`/`ProjectCreate`/`ProjectUpdate`
  compatibility aliases (the worker still imports them in `worker/src/db.ts`).
- [ ] Duties Stage 10 items not covered above: compiler-hardening flags over
  duty code, property and e2e invariant tests, final documentation sweep
  including `AGENTS.md` and `alongside-ideas.md`.
- [ ] Prune stale branches (`android-app`, `codex/*`, `claude/*`, `ccr-*`).
