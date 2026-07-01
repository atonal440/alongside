# Stage 10 — Hardening, Cleanup, and Docs

Part of `docs/plans/duties.md`. Prerequisite: the earlier stages you intend to
ship (Phase 1 = Stages 1–8 at minimum; Phase 2 = through Stage 9). This is the
"pay down the transition" stage.

## Goal

Drop the legacy `tasks.recurrence` column now that duties own recurrence, tighten
compiler settings over the new code, land the push-notification *hook* the
scheduled handler makes possible, and do the full documentation sweep so the
duties concept is coherent across every doc.

## Steps

### 1. Drop the legacy `recurrence` column

`tasks.recurrence` has been read-only since Stage 6 (writes blocked) / Stage 8
(UI stopped offering it). **Explicit rollout criterion** — do not drop the column
until *all* hold, or the drop is a data-loss risk on a client that hasn't caught
up:

1. The Stage 4 backfill has run in production and `SELECT count(*) FROM tasks
   WHERE recurrence IS NOT NULL AND duty_id IS NULL` is `0` (every legacy
   recurring task became a duty).
2. At least one release has shipped with duties live, so rollback to a
   duty-unaware build is no longer a target.
3. No deployed worker or PWA build still *reads* `recurrence` except the
   defensive fallbacks removed below.

Once satisfied:

- A hand-written `worker/migrations/00N_*.sql` dropping `tasks.recurrence` (SQLite
  needs table-recreate for a column drop) plus the `shared/schema.ts` / `schema.sql`
  change. (Migrations are hand-written SQL — `worker/drizzle.config.ts`; Drizzle is
  only a diff preview.)
- Remove the legacy `parseRrule` / `nextOccurrence` *usage* if the migration path
  (Stage 4 backfill) is the only remaining caller and it has run everywhere; keep
  the functions if any legacy-render fallback still needs them, else delete. When
  `parseRrule` goes, so does the now-dead date-only RRULE profile
  (`isDateOnlyProfile` and helpers) — the last vestige of date-only resolution
  (Decision 4 / `02-timestamp-model.md`).
- Finalize the `IsoDate` retirement started in Stage 1 Part A: confirm no domain
  or storage type still references it (presentation formatters aside) and remove
  the brand if fully unused.
- Remove the defensive "legacy recurrence-only" fallbacks in the PWA
  (`TaskMeta.tsx`, `DetailView.tsx`) and worker readers added in Stages 6–8.
- Verify with `wrangler deploy --dry-run` and a migration test that a DB with
  post-backfill data drops cleanly and duties still function.

### 2. Compiler hardening

Extend the type-driven-safety compiler-hardening posture
(`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`) over the duty modules
if they aren't already covered. Fix any patch-semantics or index-access issues
the stricter flags surface in `worker/src/domain/duty.ts`,
`worker/src/domain/ops/duty.ts`, the materializer, and the PWA duty modules.

### 3. Push-notification hook (foundation only)

The scheduled handler (Stage 5) is the only code that runs with no client
connected, which makes it the natural origin for "your duty spawned" pushes. Land
just the seam, not the transport:

- In `handleScheduled` / `materializeDueDuties`, after applying plans, surface a
  structured result of what spawned (duty id, task id, occurrence date). Expose an
  extension point (a callback or an emitted event list) that a future
  notification worker can consume.
- Do **not** build Web Push / subscriptions / a notification worker here — that is
  its own project (master "Out of Scope"). Document the seam and stop.

### 4. Property and end-to-end tests

- A property test (fast-check) over `materializeDueDuties`: for a random duty and
  a random sequence of advancing `now` instants, the total set of
  `(duty_id, occurrence_at)` instances produced is exactly the rule's
  occurrences in that window, with no duplicates and no gaps under `all`, and at
  most one open instance under `next`.
- An end-to-end worker test: create a duty → advance the clock across several
  occurrences via repeated `materializeDueDuties` → complete some instances →
  assert cursor, statuses, and carry-forward kickoff notes are all correct, and a
  finite duty ends exactly when its occurrences run out.

### 5. Documentation sweep

Reconcile every doc with the shipped system (`AGENTS.md` documentation rule):

- `AGENTS.md` "Key Decisions": replace the completion-driven recurrence line
  with the duties model (series anchor, cron + lazy-read spawning, server
  authoritative). Update the recurrence caveat that said COUNT/UNTIL are
  unsupported — they are, for duties. Add the timestamp-model decision
  (minute-resolution UTC everywhere; no date-only fields; per-duty anchor zone for
  wall-clock-stable recurrence; no global timezone) and note `due_date` is now a
  datetime.
- `docs/overview.md`: add duties to the architecture overview.
- `docs/mcp-tools.md`: final pass — duty tools, duty object shape, task
  `duty_id`/`occurrence_at`, recurrence removed from `add_task`, tool count
  correct.
- `docs/api.md`: `/api/duties*` final, task fields final.
- `docs/shared/*`, `docs/worker/*`, `docs/pwa/*`: per-file docs for the new
  modules where they add explanatory value (not mechanical mirrors — `AGENTS.md`).
- A narrative slice note (per `AGENTS.md`'s "substantial work" guidance) tying the
  duties system together: why duties exist, how an occurrence flows from cron/read
  → materialize → apply → sync → UI, the idempotency invariants, and what's
  intentionally out of scope.
- `alongside-ideas.md`: strike the recurrence items now delivered ("alternatives
  to completion-driven recurrence," "built from a template," "recurring sequence
  of blockers" if Stage 9 shipped); leave what remains.

### 6. Final verification

- Root `npm run verify` green.
- `cd worker && wrangler deploy --dry-run` green (schema + triggers + migration).
- `codex review --commit <sha>` on the final commit per repo convention.

## Acceptance criteria

- `tasks.recurrence` is gone; no code writes it and the app is fully duty-driven.
- Compiler-hardening flags pass over duty code.
- The scheduled handler exposes a notification seam (no transport built).
- Property + e2e tests lock the invariants.
- Every doc reflects duties; `alongside-ideas.md` updated.
- `docs/plans/duties-implementation-todo.md` fully checked off with a closing note.
