# Stage 5 — Triggering: Scheduled Handler and Lazy-on-Read

Part of `docs/plans/duties.md`. Prerequisites: Stages 1–4 (a working
`materializeDueDuties`). Read `00-recurrence-and-triggering.md` §5 and
`02-timestamp-model.md` first.

## Goal

Wire the two triggers onto the engine: a Cloudflare **cron scheduled handler**
that materializes due duties while the app is closed, and a **lazy-on-read** hook
that materializes before any list path returns so clients are never stale. Both
call the same idempotent `materializeDueDuties(now)` (Stage 4). Because everything
is UTC (Decision 4), `now` is just `Date.now()` — there is **no** timezone
resolution and **no** `timezone`-in-the-spawn-path preference. This stage is
markedly simpler than a date-only design would make it.

## Context for a cold start

- The worker exports only `fetch` today (`worker/src/index.ts:15`). Cloudflare
  Workers add a `scheduled(event, env, ctx)` export driven by `[triggers] crons`
  in `wrangler.toml` (`worker/wrangler.toml` has no `[triggers]` block yet).
- `Env` is `{ DB, AUTH_TOKEN }` (`index.ts:10`); the DB is `new DB(env.DB)` per
  request (`index.ts:71`).
- List read paths that must be fresh: MCP `list_tasks` / `get_ready_tasks` /
  `start_session` / `show_tasks` (`worker/src/mcp.ts`), REST task list
  (`worker/src/api.ts`), and the PWA full-sync pull endpoint. `materializeDueDuties`
  has a cheap gate (Stage 4) so calling it on every read is fine when nothing is due.
- `materializeDueDuties(now)` takes a single UTC instant (Stage 4) — no `today`.

## Steps

### 1. Cron config (`worker/wrangler.toml`)

```toml
[triggers]
crons = ["*/15 * * * *"]
```

15 minutes is a starting cadence: fine enough that app-closed lag is invisible for
day-granular duties, coarse enough to be cheap. (Sub-15-minute recurrence rules —
now expressible under Decision 4 — spawn with up to one cron interval of lag;
lazy-on-read closes it the instant a client looks.) Because materialize is
idempotent, cadence is a pure cost/latency knob, not a correctness one. Document
that it's tunable. `wrangler deploy --dry-run` must pass with the triggers block.

### 2. Scheduled handler (`worker/src/index.ts` + `worker/src/scheduled.ts`)

Add a `scheduled` export to the default object:

```ts
export default {
  async fetch(request, env) { /* unchanged */ },
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(handleScheduled(env));
  },
};
```

`handleScheduled(env)` in a new `worker/src/scheduled.ts`:

- `const db = new DB(env.DB)`.
- `const now = new Date().toISOString()` (truncate to minute per Decision 4),
  branded `IsoDateTime`. That's the whole "what time is it" step — no zone.
- `await db.materializeDueDuties(now)`.
- **Runtime budget:** cap duties processed per tick (e.g. 200) inside
  `materializeDueDuties` (ordered by cursor staleness, Stage 4, so the most-overdue
  are never starved). If the cap is hit, the next tick — or a lazy read — picks up
  the rest; idempotency makes partial progress safe.
- try/catch + log; a scheduled failure must not throw uncaught.

Add `ScheduledController` / `ExecutionContext` from `@cloudflare/workers-types`.

### 3. Lazy-on-read hook

One shared helper both surfaces call at the **top** of every list handler, before
reading tasks:

```ts
async function ensureDutiesFresh(db: DB): Promise<void> {
  await db.materializeDueDuties(isoNowMinute());   // isoNowMinute() = UTC now, minute resolution
}
```

Call sites:

- MCP: `start_session`, `list_tasks`, `get_ready_tasks`, `show_tasks` — any tool
  returning a task list — **and `list_duties`** (`worker/src/mcp.ts`).
- REST: the task list endpoint(s) in `worker/src/api.ts`, the PWA full-sync pull,
  **and `GET /api/duties`** — this is what makes the PWA see new instances after
  being offline.
- The **duty-list** endpoints (`GET /api/duties`, `list_duties`) run the gate too
  (they land in Stage 6): otherwise opening the duties surface after an occurrence
  is due but before the cron fires returns an `active` duty with
  `next_occurrence_at` still in the past (or a finite duty not yet `ended`), and
  the spawn only appears after some *task*-list read happens to refresh it.

The cheap gate (Stage 4) means the added latency on the common no-op path is one
indexed `SELECT … LIMIT 1`. Do **not** call it on single-task GETs or mutation
endpoints — only list/sync reads, to keep write paths lean.

### 4. Timezone: not at the trigger edge

There is **no** timezone to plumb *at this stage*. Decision 4 removes the global
`timezone` preference and `todayInZone` resolver an earlier draft placed here — the
scheduled handler and lazy hook both just pass a UTC `now`. The per-duty anchor
zone that Phase 1 *does* ship (`duties.timezone`) is consumed **inside**
`occurrencesBetween` per duty (Stage 2), not at the trigger edge — the driver
never touches it. Viewer-side display formatting is a separate client concern
(Stage 8). So nothing timezone-related is added in Stage 5.

### 5. Tests

- Scheduled handler (vitest workers pool can invoke `scheduled`, or test
  `handleScheduled(env)` directly): seed a due duty, run, assert an instance
  spawned; seed nothing due, run, assert the cheap gate short-circuited (no writes).
- Lazy-read: call the MCP `list_tasks` handler when a duty is due and assert the
  returned list already includes the freshly spawned instance.
- Both-drivers race: run `materializeDueDuties(now)` twice back-to-back → exactly
  one instance (idempotency end to end).
- Sub-day lag: a `FREQ` finer than the cron still materializes on the next read
  (lazy) even before the next tick.
- Per-tick cap: seed cap+N due duties, run one tick, assert cap processed and the
  remainder still pending; a second tick finishes them.

### 6. Docs

- `AGENTS.md` "Key Decisions": duties spawn via a cron scheduled handler plus
  lazy-on-read, both idempotent and UTC; cadence tunable. Note the recurrence
  caveat that previously deferred COUNT/UNTIL/time-parts is resolved (Decision 4).
- `docs/worker/overview.md` (or `docs/overview.md`): document the scheduled entry
  point and the freshness hook.
- Local dev: `wrangler dev` supports triggering the scheduled handler
  (`--test-scheduled` / the `/cdn-cgi/handler/scheduled` route); add a smoke-test
  line to `AGENTS.md`.

## Acceptance criteria

- `cd worker && wrangler deploy --dry-run` passes with `[triggers]`.
- `npm --prefix worker run typecheck` / `test` pass; scheduled + lazy-read + race +
  cap tests green.
- Opening a list path after a due instant returns the spawned instance with no
  cron tick required; the cron spawns it with no client connected.
- No timezone resolution exists anywhere in the spawn path.
- Write/single-GET paths do not call the materialize hook.
- **Transition invariants — State B/C (`duties/03`):** this stage completes the
  Stage 4 ↔ 5 atomic cut-over — verify that after deploy, recurrence is served by
  exactly one spawner (the materializer), every backfilled duty fires, and no date
  has both a legacy plain task and a duty instance.
- Root `npm run verify` passes.
- Check off Stage 5 in the implementation todo; record the chosen cron cadence and
  per-tick cap.
