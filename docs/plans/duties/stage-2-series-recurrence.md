# Stage 2 — Series recurrence primitives

Status: landed 2026-07-21; hardened 2026-10-02. This is the calendar foundation;
duty planners, materialization drivers, triggers, and public duty endpoints remain
future work under [the current product plan](../power-user-todo.md).

The implemented profile and API live in
[the recurrence reference](../../shared/parse/recurrence.md), including the
unfiltered HOURLY/MINUTELY subset, COUNT/UNTIL semantics, fixed INTERVAL phase,
host-independent zone conversion, and separate output/search guards. Future
work orders should link that contract instead of copying it.

The [hardening note](slice-2-hardening.md) explains why public library queries
were replaced, how cursor membership works without a whole-history expansion,
and how active/live-cursor predicates protect task inserts and cursor updates.
Those storage guards are available now; they do not constitute a duty engine.

Verification lives in worker/test/parse/seriesRecurrence.test.ts and
seriesSearch.test.ts: parser boundaries, finite rules, calendar differential
fixtures, host TZ independence, DST and dateline transitions, impossible-calendar
budgets, explicit limits, and legacy recurrence regression. Real SQLite storage
tests cover replay, stale plans, pause/end races, retained historical tasks,
unique conflicts, and transaction rollback.

Before changing this foundation, run root `npm run verify`. Rrule's internal
calendar adapter is version-pinned; upgrades must update all build aliases and
pass the differential fixtures plus worker/PWA bundling.
