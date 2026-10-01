# Dates, instants, and temporal resolution

The v2 foundation preserves calendar intent independently of display zones.
It does not change existing task dates, add deadlines to tasks, or enable a
background engine. Those features have separate rollout gates.

## Canonical values

`shared/parse/temporal.ts` provides parsed brands:

- `LocalDate`: a real four-digit AD `YYYY-MM-DD` (0001–9999), without UTC conversion.
- `LocalTime`: minute wall-clock text `HH:MM`.
- `MinuteInstant`: an offset-bearing ISO input normalized to UTC and truncated
  to the minute. Bare local datetimes are rejected.
- `EventInstant`: canonical UTC with millisecond precision; input precision
  greater than milliseconds is rejected rather than silently discarded.
- Positive duration (1–525600 minutes), signed offsets (±525600 minutes or
  ±3660 calendar days), safe nonnegative revisions, and bounded ASCII sort keys.
  Equal sort keys require an entity-ID tie-break; generation/rebalance lands
  with hierarchy. Entity ID parsers distinguish commands, blocks, reminders,
  duties, tags, entries, work logs, and saved queries by prefix.

`Timezone` is the existing recurrence brand, also used for planning. It accepts
UTC, the runtime's canonical Intl zone list, and Intl-validated fixed-offset
`Etc/GMT±N` identifiers. Its spelling follows the runtime's zone database;
for example some ICU versions list `Asia/Calcutta`. It does not accept common
abbreviations or host-local timezone inference.

A temporal point is a strict tagged union:

```json
{"kind":"date","date":"2026-09-30","timezone":"America/Los_Angeles"}
```

```json
{"kind":"instant","at":"2026-09-30T16:00:00Z","timezone":"America/Los_Angeles"}
```

## Boundaries and offsets

`shared/temporal/index.ts` resolves date availability to the first valid minute
of the date. Targets/deadlines use the first minute **after** the date as an
exclusive boundary. It never assumes a 24-hour day. A skipped following date
does not invalidate the preceding date's interval; a wholly skipped requested
date returns `skipped_local_date`. Midnight folds select the earliest minute.
Date boundaries require their requested resulting instant to remain in years
0001–9999; availability resolves only the start, without requiring an end.
Historical wall times or date boundaries requiring sub-minute precision return
`unsupported_precision` rather than claiming an exact minute-aligned result.

One-off wall times reject spring gaps, returning offset-derived alternatives.
Folds default to `ambiguous_local_time`; callers must choose `earlier` or
`later`. Series recurrence keeps its existing skip-gap/earlier-fold policy.

Elapsed offsets add exact minutes to an instant. Applied to a date they require
an explicit `dateAnchorTime`; that field is rejected for every other offset
combination. Offset DST errors identify `dateAnchorTime` or `offset.localTime`,
matching the submitted field. Calendar offsets move the canonical zoned date
and resolve the requested `localTime`; they can produce a DST gap/fold error.
Instant projections can briefly fall in internal year zero/10000; calendar
arithmetic happens before validating the final date so offsets can re-enter the
supported AD range. Overflow errors name `offset.days` or `offset.minutes`.
Intervals are half-open `[start,end)` with end strictly after start.

## Configuration and capabilities

Migration `009_planning_foundation.sql` adds an empty singleton
`planning_settings` plus constrained weekday working hours. Parsed settings
carry timezone, minute buffer, working hours, and revision. Overnight rules
must be split at midnight. This step exposes reads only; explicit configuration
writes land with reliable commands, avoiding an unguarded mutation path.
No existing task, preference, recurrence anchor, or due marker is rewritten.
Portable settings export/import also lands with that command layer; there are
no public settings writers in this step.

`get_capabilities` reports server event time, contract version 2, interpreted
zone, `timezoneSource`, setup requirement, limits, features, and delivery state.
An explicit request zone wins over a stored setting. Without either, UTC is
returned as `fallback_utc`, with `setupRequired: true`. The host timezone never
supplies user intent. New graph/date/reminder/command/sync features remain false;
inbox is unavailable, Web Push unconfigured, and background work disabled.

## Legacy dry-run

`preview_legacy_dates` classifies due values without writing:

| Existing marker | Proposed target | Provenance |
| --- | --- | --- |
| `true` | Date from the stored UTC date | `legacy_all_day` |
| `false` | UTC minute instant | `legacy_timed` |
| `null` | Existing all-day fallback, UTC date | `legacy_ambiguous` |

Each candidate preserves the original due string/marker and attaches the
interpreted zone. Invalid values are returned as unresolved rows. Nothing
becomes a hard deadline automatically. Keyset pages are bounded at 500 rows,
with an `after` task ID and returned `nextCursor`. `consistentSnapshot: false`
is explicit: this preparatory report is not a concurrent migration snapshot.
The guarded migration in the task-date slice must revalidate before writes.

## New boundaries

`shared/wire/planning.ts` owns strict inputs and response parsers. Unknown keys
and explicit null are rejected; omission requests documented defaults. The PWA
API layer exposes parsed capability/resolution/preview calls without UI changes
or offline writes. REST and MCP dispatch to the same domain functions. New
validation/DST errors carry code, path, message, retryability and recovery hint;
MCP returns a tool error with structured content, preserving machine readability.
The PWA keeps v2 details in `ApiErrorBody.contractError` while exposing the
human message through `error`; codes, recovery hints and DST alternatives remain
available. Every JSON error on a v2 caller passes a boundary parser, including nested
alternative dates/times. Declared versioned string envelopes fail parsing;
only validated unversioned string envelopes use the legacy fallback. Legacy auth errors
still use the existing string shape. Fresh `db:init` also records migration 009
in its migration bookkeeping so subsequent upgrades do not replay its DDL.

Reference schema initialization is repeatable (`IF NOT EXISTS`), preserving
existing settings. The applied migration remains a strict one-time DDL change.
