# Foundation 00 — Recurrence and Triggering

Part of `docs/plans/duties.md`. Read the master's Context and Design Pillars
first. This document works through the two questions the whole plan rests on:
**how does recurrence actually work once it's a series anchor**, and **what
triggers a duty to spawn**. It is analysis, not a work order — the stages
implement what this concludes.

## 1. Where recurrence lives today, and why it can't grow

The current engine is one function. `DB.completeTask` (`worker/src/db.ts:286`)
loads the task, parses it to a `PendingTaskDomain`, and calls
`completeTaskPlan` (`worker/src/domain/ops/task.ts:35`). If the task's
`recurrence.kind === 'recurring'`, that planner:

```
nextDue      = nextOccurrence(task.recurrence.parts, task.recurrence.firstDue)
nextKickoff  = task.sessionLog ?? task.kickoffNote
ops         += task.insert { …template copied from the completed task…, due_date: nextDue }
```

`nextOccurrence(parts, from)` (`shared/parse/recurrence.ts:213`) builds an RRULE
with `dtstart = from` and returns `rule.after(from, false)` — the first
occurrence strictly after `from`. Three properties fall out of this design and
each is a wall:

- **`from` is the current instance's `due_date` (`firstDue`), so there is no
  fixed anchor.** The rule is re-seeded from wherever the last instance landed.
  For `FREQ=WEEKLY` that is harmless; for `FREQ=MONTHLY;BYDAY=3FR` it is fine
  *only because* the current parser rejects anything whose semantics would drift.
  It also means the series has no birthday — you cannot ask "what was the 1st
  occurrence" or "is this series finished."
- **The rule must be infinite.** `parseRruleParts` calls `isNonEmptyInfiniteRule`
  and rejects `COUNT` / `UNTIL` (they aren't even in `SUPPORTED_KEYS`). A finite
  series ("every day for 30 days") is unrepresentable, because a
  completion-driven engine has nowhere to store "how many are left" and no way to
  *end*.
- **Spawning is welded to completion.** No completion, no next instance. The
  cadence is the user's behavior, not the calendar.

The type system already names the shape we want but stops short: `Recurrence`
(`worker/src/domain/task.ts:44`) is `{ kind: 'one_shot' } | { kind: 'recurring';
rrule; parts; firstDue }`. `firstDue` is a proto-`dtstart` — it just lives on the
task instead of on a series object, and it moves every cycle.

## 2. Recurrence as a series anchor

A duty fixes all three problems by storing the anchor once and evaluating the
rule against it forever.

```
duty.dtstart   fixed at creation; the series' first candidate instant (UTC datetime)
duty.rrule     the recurrence, now allowed to be finite (COUNT / UNTIL) and time-capable
duty.last_spawned_at   cursor: the occurrence instant of the newest spawned instance
```

(Timestamps are UTC instants at minute resolution — see `02-timestamp-model.md`.
The engine below works entirely in instants; there is no date-only value and no
"today". That is what makes the trigger section (§5) and timezone handling (§6)
simpler than a date-only design.)

The RRULE is *always* expanded with `DTSTART = duty.dtstart`. That single change
is what makes the rest correct:

- **Stable calendar semantics.** `FREQ=MONTHLY;BYDAY=3FR` from
  `dtstart=2026-03-20` yields 2026-03-20, 2026-04-17, 2026-05-15, … regardless of
  when any instance was completed or whether one was skipped.
- **Finite series become expressible.** `FREQ=DAILY;COUNT=30` from a fixed
  `dtstart` has exactly 30 occurrences. `FREQ=WEEKLY;UNTIL=20261231` stops at
  year end. When the cursor passes the last occurrence, the duty is *done* —
  `status` transitions to `ended`.
- **The cursor decouples spawn from completion.** "What's the next occurrence to
  spawn" is `occurrencesBetween(rule, dtstart, after=last_spawned_at,
  through=now)` — a pure function of the calendar and the cursor. Completion
  never enters into it.

### The materialization primitive

Stage 2 adds one function that the whole engine leans on:

```ts
// All occurrence instants strictly after `after`, up to and including `through`.
// `after = null` means "from dtstart inclusive". Bounded and finite: it stops at
// `through`, at the rule's own COUNT/UNTIL, or at a hard cap.
occurrencesBetween(parts: SeriesRruleParts, dtstart: IsoDateTime,
                   after: IsoDateTime | null, through: IsoDateTime): IsoDateTime[]
```

and its companion:

```ts
// True when the rule is finite and has no occurrence strictly after `after`.
isSeriesExhausted(parts: SeriesRruleParts, dtstart: IsoDateTime, after: IsoDateTime): boolean
```

`nextOccurrence` (the old strictly-after-one primitive) stays for the legacy
migration path but is no longer the engine.

### The materialization algorithm

`materializeDutyPlan(duty, now)` — pure, deterministic, no clock reads (`now` is
the current UTC instant, passed in):

```
if duty.status != 'active':            return empty plan            # paused/ended never spawn
after   = duty.last_spawned_at          # null on a brand-new duty
missed  = occurrencesBetween(parts, dtstart, after, now)            # [] when nothing is due yet
if missed is empty:
    if isSeriesExhausted(parts, dtstart, after):                    # finite rule ran out
        return plan[ duty.update { status: 'ended' } ]
    return empty plan

spawnAt = applyCatchUp(duty.catch_up, missed)                       # see §3
ops = spawnAt.map(t => task.insert(instanceFromTemplate(duty, occurrence_at=t)))
newCursor = max(missed)                                             # advance past ALL missed, even if collapsed
ops += duty.update { last_spawned_at: newCursor,
                     status: isSeriesExhausted(parts, dtstart, newCursor) ? 'ended' : 'active' }
return plan[ ...ops ]  with assertion duty.exists(duty.id)
```

Note the cursor advances to `max(missed)` even when `catch_up: 'next'` collapses
five missed occurrences into one spawned task. The cursor tracks *what the
calendar has produced*, not *how many tasks we chose to create* — otherwise the
next tick would re-spawn the collapsed ones.

The plan is executed by the existing `apply` engine (`worker/src/storage/apply.ts`).
`task.insert` already exists; Stage 3 adds `duty.update`. No new execution model.

## 3. Catch-up: what happens when occurrences were missed

If the app was closed for a week, a daily duty has seven un-spawned occurrences.
Two policies, stored per duty as `catch_up`:

- **`next` (default).** Collapse all missed occurrences into a **single** task,
  dated at the most recent missed occurrence. You come back Monday to *one*
  "water the plants," not seven. This is the humane default and it prevents
  pile-up: a `next` duty has at most one open un-completed instance at a time
  (see below). Chosen because most personal duties are "keep this current," not
  "account for every past instance."
- **`all`.** Spawn one task per missed occurrence. For duties where each instance
  is a distinct obligation (a daily journal entry, a billable log), you want the
  backlog to be real. This can pile up, by design.

**Pile-up guard for `next`.** Before spawning, `applyCatchUp('next', …)` also
checks whether an open (pending, uncompleted) instance for this duty already
exists; if so, it re-dates that instance forward rather than adding a second. The
practical rule: a `next` duty never shows you two open copies of itself. The
cleanest implementation is a precheck/lookup in the materializer's DB-facing
wrapper (`materializeDueDuties`), which knows the open-instance count; the pure
`materializeDutyPlan` receives that count as an input so it stays testable. Stage
4 specifies the exact signature.

## 4. Idempotency: the cron and a read will race

With two triggers (§5), the same occurrence *will* be materialized twice
concurrently. Correctness cannot assume otherwise. Two layers defend it:

1. **Cursor as the fast path.** `materializeDutyPlan` only considers occurrences
   after `last_spawned_at`. Once one driver advances the cursor, the other sees
   nothing to do. Because the cursor advance and the task insert are in the *same
   `Plan`*, `apply` runs them in one D1 batch (one transaction), so the cursor and
   the instance commit together or not at all.
2. **`UNIQUE(duty_id, occurrence_at)` as the hard backstop.** If two batches
   interleave before either commits, the second `task.insert` violates the unique
   index. Stage 4 makes `apply` treat that specific constraint violation as a
   benign no-op for duty-instance inserts (the occurrence already exists — that
   *is* success), not an error. The result is exactly one instance per
   `(duty, occurrence_at)`, always.

This is why the master plan calls spawning "idempotent by construction": neither
driver needs to know about the other.

## 5. Triggering — the decision, and the alternatives

The chosen mechanism is **Cron Trigger + lazy on-read.** Reasoning, against the
alternatives:

### Cron Trigger (Cloudflare scheduled handler)

The worker currently exports only `fetch` (`worker/src/index.ts:15`). Cloudflare
Workers also support a `scheduled(event, env, ctx)` export driven by a
`[triggers] crons = [...]` block in `wrangler.toml`. On each tick it loads all
`active` duties, materializes each against `now` (the current UTC instant), and
applies the plans.

- **Strength:** duties fire while the app is closed. This is the whole point of a
  series anchor — the calendar advances without you. It is also the *only* place
  a future push notification can originate (Stage 10's hook), because it's the
  only code that runs when no client is connected.
- **Weakness:** a new instance appears only after the next tick. At a 15-minute
  cron that's a ≤15-minute lag — invisible for date-granular duties, but it means
  the cron alone can render a client briefly stale right after midnight.
- **Cost/limits:** the scheduled handler shares the Worker CPU/subrequest budget.
  With a handful-to-hundreds of personal duties this is trivial, but Stage 5
  still puts a hard cap on duties processed per tick and uses
  `ctx.waitUntil`-friendly batching so a pathological duty count can't blow the
  time limit. Cron frequency is a cost/latency knob, not a correctness one —
  idempotency (§4) means ticking more often is always safe.

### Lazy on-read

Every list path — MCP `list_tasks`/`get_ready_tasks`, REST list, PWA sync pull —
calls `materializeDueDuties(db, now)` before returning, so whatever the client
is about to render is already caught up.

- **Strength:** zero perceived lag. The instant you open the app after midnight,
  today's instances are there, cron tick or not. No new infrastructure.
- **Weakness:** nothing spawns while nobody reads. On its own it cannot power
  notifications and cannot catch up a long-idle account until someone opens it —
  which for catch-up (`all`) means the backlog only materializes on next visit.
- **Cost control:** it must be cheap on the common path. Gate it: a single
  indexed query "does any `active` duty have `last_spawned_at < now` (or NULL)?"
  short-circuits the whole thing when there's nothing to do, which is the usual
  case. Only when that guard trips does the full materialize run.

### Why both, not either

They cover each other's gap exactly. Cron gives **app-closed** spawning and the
notification origin; lazy-read gives **zero-lag** freshness and a safety net if
the cron is delayed or misconfigured. Because both call the *same* idempotent
`materializeDueDuties`, running both is not double work — the second one to run
finds the cursor already advanced and does nothing. This is only safe *because*
of §4; the idempotency work is what makes "both" free.

### The two rejected options

- **Cron only.** Gives app-closed spawning but reintroduces visible lag and makes
  the UI's freshness depend on cron frequency — pushing you toward an
  aggressive cron purely for UX, which wastes invocations. Rejected: lazy-read
  removes the lag for near-zero cost.
- **Lazy-read only.** No new infra, but a duty that should fire Tuesday while you
  don't open the app until Friday can't notify you Tuesday, and a purely
  server-side catch-up (for future automations, digests, notifications) is
  impossible. Rejected: it forecloses the notification future the product wants.
- **Keep completion-driven** was rejected at the master level: it cannot enforce
  calendar cadence and stalls the instant you miss one completion.

## 6. Timezone — nothing to resolve

An earlier draft of this section resolved a per-user "today" in the user's IANA
timezone at the trigger edge, because a date-only duty that fires "daily" has to
pick *someone's* midnight. Decision 4 (`02-timestamp-model.md`) deletes that
entire problem: there are no dates and no "today." A duty's `dtstart` and every
occurrence are UTC instants; the rule is expanded in UTC; the materializer
receives a UTC `now` and compares instants. The cron and a lazy read both compute
`now = Date.now()`, so they agree by construction — no per-user zone, no
resolver, no `timezone`-in-the-spawn-path preference.

Timezone survives only as **presentation**: the PWA formats a stored instant into
the viewer's local zone at render time (§Presentation of `02`). The server never
needs to know a user's zone to decide what to spawn.

The one residual UX cost is DST drift: a rule fixed at `14:00Z` fires at a
different local wall-clock time across a DST boundary. This is the deliberate,
documented tradeoff of "UTC everywhere." The fix — an optional per-duty *anchor
zone* used only to expand the rule (occurrences still stored UTC) — is the current
lean and is designed additively in `02-timestamp-model.md`, but is planned for the
later reminders / timeboxing track, not Phase 1. It does not affect any stage
below; every stage here assumes UTC expansion.

## 7. Completion, after duties

Once duties own spawning, completing a duty instance is just completing a task:
`completeTaskPlan`'s recurrence branch is deleted (Stage 4). The instance's
`session_log` still carries forward as the *next* instance's `kickoff_note`, but
that carry-forward now happens in the materializer (it reads the most recent
completed instance's `session_log` when building the next one), not in the
completion path. This preserves the "re-entry ramp" behavior the current engine
provides (`worker/src/domain/ops/task.ts:57`) while decoupling it from *when* you
complete.

Edge case worth stating: because spawn is calendar-driven, you can have an open
instance from last week and a newly spawned one for this week at the same time
under `catch_up: 'all'`. That is intended. Under `catch_up: 'next'` the pile-up
guard (§3) keeps it to one.

## Open questions deferred to their stages

- Exact open-instance-count signature for the `next` pile-up guard → Stage 4.
- Whether the scheduled handler processes duties in id order or cursor-staleness
  order under the per-tick cap → Stage 5 (staleness order, so the most-overdue
  duties can't be starved).
- Whether deleting a duty cascades to its spawned instances or orphans them
  (keep the tasks, null the `duty_id`) → Stage 6. Current lean: keep the tasks —
  they're real work the user may still want — and stop future spawns.
