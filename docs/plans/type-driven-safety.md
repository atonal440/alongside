# Type-Driven Safety Plan

## Summary

Alongside currently uses database row types (`Task`, `Duty`, etc.) in too many places: public API inputs, MCP inputs, DB inserts, PWA local drafts, import/export payloads, and internal domain logic. The duty recurrence PR exposed the cost of that: caller-supplied internal fields, invalid date strings, malformed RRULEs, timezone assumptions, and import integrity issues were all easy to express in code and only caught by review.

The goal is to move toward a type-driven model where unsafe external data is parsed at boundaries, internal code receives validated domain types, and illegal states become hard or impossible to compile.

## Key Changes

### Split Row, Input, and Domain Types

- Keep Drizzle row types as storage shapes only: nullable strings, DB column names, and historical fields.
- Define separate public input types for REST and MCP payloads instead of reusing DB row or broad shared types.
- Define internal DB insert types that make generated fields and internal-only fields explicit.
- Continue the `TaskCreate` vs `DutyTaskCreate` split: public task creation must not include duty materialization keys.
- Introduce domain-level task/duty shapes for scheduling logic so recurrence code does not operate on raw rows.

### Introduce Branded Validated Types

Add lightweight branded string types in shared code for values that must not be "any string":

- `TaskId`, `ProjectId`, `DutyId`
- `IsoDate` for `YYYY-MM-DD`
- `IsoDateTime` for UTC ISO timestamps
- `IanaTimezone`
- `RRule`
- `DutyFireAt`

Use parser functions at boundaries:

- `parseIsoDate(value): Result<IsoDate, ValidationError>`
- `parseIsoDateTime(value): Result<IsoDateTime, ValidationError>`
- `parseIanaTimezone(value): Result<IanaTimezone, ValidationError>`
- `parseRRule(value): Result<RRule, ValidationError>`

Internal helpers such as `dateAtMidnightInTz`, `computeNextFire`, and duty creation/update code should accept branded types once input has been validated.

### Boundary Validation Pattern

All untrusted input starts as `unknown` or a narrow request-body type and is parsed before use:

```text
REST/MCP/PWA/import input
  -> parse and validate
  -> branded domain values
  -> business logic
  -> DB row serialization
```

Apply this first to the recurrence surface:

- `first_fire_date` must become `IsoDate` before date math.
- `timezone` must become `IanaTimezone` before schedule math.
- `recurrence` must become `RRule` before creating or updating a duty.
- `next_fire_at` / `duty_fire_at` must become `IsoDateTime` before persistence.

### Make State Transitions Explicit

Model recurrence states with discriminated unions where it improves safety:

```ts
type OneShotTask = { kind: 'one_shot'; task: TaskDomain };
type DutyTask = { kind: 'duty_instance'; task: TaskDomain; dutyId: DutyId; dutyFireAt: DutyFireAt };
type LegacyRecurringTask = { kind: 'legacy_recurring'; task: TaskDomain; recurrence: RRule };
```

Completion and materialization code should branch on these states explicitly instead of inferring behavior from nullable row fields.

## First Implementation Slice

Start small and finish one vertical slice before broad refactoring:

1. Add branded types and parser helpers for `IsoDate`, `IsoDateTime`, `IanaTimezone`, and `RRule`.
2. Convert `worker/src/duties.ts` to accept branded schedule values internally.
3. Update REST and MCP duty create/update handlers to parse boundary input once, then pass branded values onward.
4. Keep DB serialization local to `DB` methods so branded domain values are converted back to strings at the storage boundary.
5. Leave broad task/project typing alone until recurrence paths are covered.

This slice should preserve existing API wire shapes. It changes TypeScript structure and validation clarity, not user-facing JSON names.

## Test Plan

Add worker tests before or alongside the refactor. The first useful set should cover issues found in the duty PR:

- `parseIsoDate` accepts valid calendar dates and rejects malformed/impossible dates such as `tomorrow`, `2026-02-31`, and empty strings.
- `parseIanaTimezone` accepts `America/Los_Angeles` and rejects invalid timezone strings.
- `parseRRule` accepts supported `FREQ=DAILY|WEEKLY|MONTHLY|YEARLY` with positive integer `INTERVAL`, and rejects typos or non-numeric intervals.
- `dateAtMidnightInTz` preserves local calendar day for non-UTC timezones.
- `computeNextFire` advances schedules without DST drift for representative daily/weekly cases.
- Public `addTask` cannot set `duty_id` or `duty_fire_at`; only internal duty materialization can.
- REST and MCP duty create/update reject invalid recurrence/date/timezone inputs before persistence.
- Legacy recurring task conversion runs before task listing, duty listing, and completion.
- Import preflight rejects duplicate duty IDs, bad duty project references, bad task duty references, and duplicate duty fire keys before any chunked wipe.

Add a repo-level verification command once tests exist:

```sh
npm run verify
```

It should run worker typecheck, worker tests, worker dry-run bundle, PWA typecheck, and PWA build.

## Assumptions

- Keep REST and MCP JSON wire shapes stable for now.
- Do not introduce a runtime schema library in the first slice unless the implementation becomes noisy; plain TypeScript parser helpers are enough to start.
- Prefer incremental safety around recurrence and duties before refactoring unrelated task/project code.
- DB rows remain plain storage records. Domain logic should move away from operating directly on nullable row fields.
