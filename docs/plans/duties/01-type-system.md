# Foundation 01 — What Duties Add to the Type System

Part of `docs/plans/duties.md`. Read `00-recurrence-and-triggering.md` first.
This document is the complete inventory of new types duties introduce and where
each lives. It follows the four-layer discipline from
`docs/plans/type-driven-safety.md` (WIRE → INPUT → DOMAIN → ROW) and the PWA's
parse-at-every-boundary rules from `docs/plans/pwa-type-safety.md`. Nothing here
is implemented in this doc; the stages implement it, and each stage's "Types"
section points back here.

The guiding constraint: **a duty that cannot legally exist must fail to parse,
not fail at runtime.** A finite RRULE with zero occurrences, a paused duty whose
cursor sits before its anchor, a `duty_id` on a task with no `occurrence_at` —
each is caught by a parser or a domain codec, the same way `taskFromRow` already
rejects a deferred done task.

## INPUT layer — brands and enums (`shared/parse/`)

### Identifiers (`shared/parse/ids.ts`)

Mirror the existing `TaskId` / `ProjectId` trio exactly
(`shared/parse/ids.ts:6-12`):

```ts
export type DutyId       = Brand<string, 'DutyId'>;
export type ParsedDutyId = DutyId & Brand<string, 'ParsedDutyId'>;
export type MintedDutyId = DutyId & Brand<string, 'MintedDutyId'>;

export const DUTY_ID_PATTERN = /^d_[0-9A-Za-z_-]{5,}$/;
export const DutyIdSchema = v.pipe(v.string(), v.regex(DUTY_ID_PATTERN, …),
                                   v.transform(v => v as ParsedDutyId));
export function parseDutyId(input: unknown): Result<ParsedDutyId, ValidationError[]>;
```

Minting mirrors `mintTaskId` (`worker/src/db.ts:86`): `d_${nanoid(5)}` branded
`MintedDutyId`.

### Enums (`shared/parse/enums.ts`)

Add to the existing `as const` registries (`shared/parse/enums.ts:6-10`) and
their parsers:

```ts
export const DUTY_STATUSES   = ['active', 'paused', 'ended'] as const;
export const CATCH_UP_POLICIES = ['next', 'all'] as const;

export type DutyStatus     = Brand<(typeof DUTY_STATUSES)[number], 'DutyStatus'>;
export type CatchUpPolicy  = Brand<(typeof CATCH_UP_POLICIES)[number], 'CatchUpPolicy'>;
export function parseDutyStatus(input: unknown): Result<DutyStatus, ValidationError[]>;
export function parseCatchUpPolicy(input: unknown): Result<CatchUpPolicy, ValidationError[]>;
```

Also extend `TOOL_NAMES` (`shared/parse/enums.ts:11`) with the new duty tools —
that registry is the source of truth for MCP dispatch and action-log policy, so
duty tools must be added there or they fail typecheck downstream.

### Series recurrence (`shared/parse/recurrence.ts`)

The current `Rrule` / `RruleParts` model an **infinite, date-only** rule. Duties
need a **series** rule that may be finite and carries a time-of-day (Decision 4 —
everything is a UTC instant now). Rather than loosen the existing `RruleSchema`
(still used by the legacy task path until Stage 10), add a parallel, wider
profile:

```ts
export type SeriesRrule = Brand<string, 'SeriesRrule'>;

export interface SeriesRruleParts extends RruleParts {
  count?: PositiveInt<10_000>;   // from COUNT=
  until?: IsoDateTime;           // from UNTIL= (UTC instant)
}

export const SeriesRruleSchema = v.pipe(v.string(),
  v.check(value => parseSeriesRrule(value).ok, …),
  v.transform(value => value as SeriesRrule));

export function parseSeriesRrule(input: unknown):
  Result<{ rrule: SeriesRrule; parts: SeriesRruleParts }, ValidationError[]>;
```

`parseSeriesRrule` extends `SUPPORTED_KEYS` with `COUNT` and `UNTIL`, drops the
`isNonEmptyInfiniteRule` requirement (finite is now legal), and **drops the
date-only profile entirely** — the rule is expanded against a datetime `DTSTART`
in UTC, which is `rrule`'s native mode. It adds:

- `COUNT` must be a positive integer ≤ 10 000 (bounds the materialization loop).
- `UNTIL` must be a UTC instant and be ≥ `dtstart` (validated where `dtstart` is
  known — the domain codec, since the parser sees the rule string alone).
- The rule must still produce **at least one** occurrence from `dtstart`
  (an empty series is a user error, not a valid duty).

Two new pure calendar functions, working in instants (see
`00-recurrence-and-triggering.md` §2):

```ts
export function occurrencesBetween(parts: SeriesRruleParts, dtstart: IsoDateTime,
                                   after: IsoDateTime | null, through: IsoDateTime): IsoDateTime[];
export function isSeriesExhausted(parts: SeriesRruleParts, dtstart: IsoDateTime,
                                  after: IsoDateTime): boolean;
```

`nextOccurrence` stays as-is for the migration path.

### Timezone — a per-duty rule-expansion input (Phase 1, Decision 4)

`Timezone` is a real Phase-1 brand (IANA membership via
`Intl.supportedValuesOf('timeZone')`), added in Stage 2/3:

```ts
export type Timezone = Brand<string, 'Timezone'>;
export function parseTimezone(input: unknown): Result<Timezone, ValidationError[]>;
```

It is a **per-duty, nullable** field (`duties.timezone`), used *only* to expand a
duty's rule (`occurrencesBetween` — Stage 2), never a user-global setting and
never stored on an instant. The materializer itself still takes a plain UTC `now`;
the zone is consulted inside `occurrencesBetween` for that duty. The same brand is
reused PWA-side for **display** (formatting an instant into the viewer's local
zone). Two narrow uses — expansion and display — per `02-timestamp-model.md`'s
"two conversions, two zones."

## DOMAIN layer (`worker/src/domain/`)

### `DutyDomain` (`worker/src/domain/duty.ts`, new)

A discriminated union on `status`, mirroring how `TaskDomain` discriminates on
lifecycle (`worker/src/domain/task.ts:84`):

```ts
export interface DutyTemplate {
  title: NonEmptyString<200>;
  notes: BoundedString<10_000> | null;
  kickoffNote: BoundedString<2_000> | null;
  taskType: TaskType;
  projectId: ProjectId | null;
}

export interface DutySeries {
  rrule: SeriesRrule;
  parts: SeriesRruleParts;
  dtstart: IsoDateTime;            // immutable anchor
  timezone: Timezone | null;      // anchor zone for expansion; null = UTC
  cursor: IsoDateTime | null;     // last_spawned_at
  nextOccurrenceAt: IsoDateTime | null;   // next un-spawned occurrence; drives the due-gate
  catchUp: CatchUpPolicy;
}

export interface DutyBase {
  id: DutyId;
  template: DutyTemplate;
  series: DutySeries;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export type ActiveDuty = DutyBase & { status: 'active' };
export type PausedDuty = DutyBase & { status: 'paused' };
export type EndedDuty  = DutyBase & { status: 'ended' };
export type DutyDomain = ActiveDuty | PausedDuty | EndedDuty;

export function dutyFromRow(row: DutyRow): Result<DutyDomain, ValidationError[]>;
```

`dutyFromRow` enforces the cross-field invariants a single-column parser can't:

- `until` (if present) ≥ `dtstart`.
- `cursor` (if present) ≥ `dtstart` — a cursor *before* the anchor is impossible
  (you cannot have spawned before the series began).
- `cursor` must be an actual occurrence of the rule, or `null` — a cursor
  off the calendar means a corrupt row.
- `nextOccurrenceAt`, if non-null, must be a real occurrence of the rule —
  strictly after `cursor` when the cursor is set, or **at or after `dtstart`**
  when the cursor is null (a new/backfilled duty seeds `nextOccurrenceAt =
  dtstart`, the un-spawned first occurrence) — consistent with the anchor zone.
- An `ended` duty must have `nextOccurrenceAt = null` and a genuinely exhausted
  series at `cursor`; a `null`-cursor duty is never `ended` (its `dtstart`
  occurrence hasn't been consumed — this is the `COUNT=1` / future-`dtstart` case
  that must not be marked ended prematurely).

Phase 2 (Stage 9) widens `DutyTemplate` from a single task shape to
`{ tasks: DutyTaskTemplate[]; links: DutyTemplateLink[] }`. The single-task
`DutyTemplate` above is deliberately a *degenerate one-node graph* so the Stage 9
change is additive, not a rewrite — model it now as a template with an implicit
single node.

### Mutation ops (`worker/src/domain/Op.ts`)

Extend the `Op` union (`worker/src/domain/Op.ts:18`) and `PreCheck`
(`worker/src/domain/Op.ts:12`):

```ts
export type DutyRow      = typeof duties.$inferSelect;   // from shared/schema.ts
export type DutyRowPatch = Partial<Omit<DutyRow, 'id' | 'created_at'>>;

// added to Op:
  | { kind: 'duty.insert'; row: DutyRow }
  | { kind: 'duty.update'; id: DutyId; patch: DutyRowPatch }
  | { kind: 'duty.update_cursor'; id: DutyId; lastSpawnedAt: IsoDateTime; nextOccurrenceAt: IsoDateTime | null; updatedAt: IsoDateTime }
  | { kind: 'duty.orphan_open'; id: DutyId; updatedAt: IsoDateTime }   // bulk-detach all open instances of a duty (one UPDATE)
  | { kind: 'duty.delete'; id: DutyId }

// added to PreCheck:
  | { kind: 'duty.exists'; id: DutyId }
```

The dedicated `duty.update_cursor` op exists so `apply` can execute the cursor
advance as **monotonic** compare-and-set SQL (`SET last_spawned_at = :new WHERE
last_spawned_at IS NULL OR last_spawned_at < :new`), which a generic `duty.update`
patch cannot express (see `00` §4). No `duty.occurrence_free` precheck is needed:
duplicate-instance idempotency rides on the `UNIQUE(duty_id, occurrence_at)` index
handled inside `apply` (Stage 4).

### Plan builders (`worker/src/domain/ops/duty.ts`, new)

Pure `(...) => Result<Plan, AppError>`, in the style of `worker/src/domain/ops/task.ts`:

```ts
createDutyPlan(input, ids, now): TaskPlanResult    // duty.insert; materialize the first occ. if firstOcc <= now (not dtstart)
updateDutyPlan(duty, patch): TaskPlanResult        // duty.update on TEMPLATE fields + catch_up ONLY
setDutyStatusPlan(duty, next): TaskPlanResult       // active⇄paused, →ended (guarded transitions)
deleteDutyPlan(duty): TaskPlanResult                // orphan instances (null duty_id+occurrence_at) + duty.delete
materializeDutyPlan(duty, ctx): TaskPlanResult       // the engine; see Stage 4 for ctx shape
```

`createDutyPlan` takes `now` because it may materialize the first occurrence
immediately. `updateDutyPlan` edits **template fields and `catch_up` only**. The
whole series anchor — `rrule`, `dtstart`, **and `timezone`** — is immutable
(Pillar 5): all three define the occurrence calendar, so changing any of them would
strand the cursor off the new calendar and violate the Stage 3 invariant that
`last_spawned_at` be an occurrence under the duty's current rule + zone. Changing
the zone is therefore also `end_duty` + `create_duty`. `setDutyStatusPlan` encodes
the legal transitions:
`active→paused`, `paused→active`, `active→ended`, `paused→ended`; `ended` is
terminal (resuming a finished series means creating a new duty). `deleteDutyPlan`
orphans instances (nulling both `duty_id` and `occurrence_at`) — the decided
behavior, not a Stage 6 open question. Illegal transitions return
`invalid_transition`.

### Errors (`worker/src/domain/errors.ts`)

No new error *kinds* — the existing `validation | not_found | conflict |
invalid_transition | invariant_violation | storage` union
(`docs/plans/type-driven-safety.md`) already covers everything: a finite series
with no occurrences is `validation`; resuming an `ended` duty is
`invalid_transition`; a missing duty on update is `not_found`.

## ROW layer

### Schema (`shared/schema.ts`)

The `duties` table and `tasks.duty_id` / `tasks.occurrence_at` columns from the
master plan's Data Model, plus:

```ts
export type Duty = typeof duties.$inferSelect;
```

and the `UNIQUE(duty_id, occurrence_at)` index (Drizzle `uniqueIndex(...)` mirrored
in the hand-written `worker/migrations/00N_*.sql` — Stage 1). `action_log` also
gains a nullable `duty_id`.

### Shared row schema (`shared/wire/rows.ts`)

A valibot `DutyRowSchema` — the single source of truth consumed by the worker's
import parser *and* the PWA's response/IDB parsers, exactly as `TaskRow` schemas
are shared today (`shared/wire/rows.ts`). Field-level only (no cross-field
invariants — those live in `dutyFromRow` and the PWA decode checks):

```ts
export const DutyRowSchema = v.object({
  id: DutyIdSchema, title: NonEmptyStringSchema(200), notes: v.nullable(...),
  kickoff_note: v.nullable(...), task_type: TaskTypeSchema,
  project_id: v.nullable(ProjectIdSchema),
  rrule: SeriesRruleSchema, dtstart: IsoDateTimeSchema,
  timezone: v.nullable(TimezoneSchema),
  status: DutyStatusSchema, catch_up: CatchUpPolicySchema,
  last_spawned_at: v.nullable(IsoDateTimeSchema),
  next_occurrence_at: v.nullable(IsoDateTimeSchema),
  created_at: IsoDateTimeSchema, updated_at: IsoDateTimeSchema,
});
```

Extend `TaskRowSchema` with `duty_id: v.nullable(DutyIdSchema)` and
`occurrence_at: v.nullable(IsoDateTimeSchema)` (and note the pre-existing
`due_date` field is now `IsoDateTimeSchema`, not date-only — Decision 4, applied
app-wide in Stage 1 Part A). **Wire field names never change** once shipped (the
pwa-type-safety contract).

## WIRE layer

### REST route specs (`worker/src/wire/rest.ts`)

New typed route specs alongside the task ones (`worker/src/wire/rest.ts`):
`DutyCreateBody`, `DutyUpdateBody`, `DutyStatusBody`, and path-param parsing for
`/api/duties/:duty_id`. Bodies reference the shared brands so a malformed RRULE or
status is rejected at the edge with a `validation` error, before any DB call.

### MCP registry (`worker/src/mcp.ts`)

Duty tools added to the MCP tool registry with JSON-schema argument specs derived
from the same brands. Per the type-driven-safety "specs are the source of truth"
pillar, the exposed JSON schema, the argument parser, and the action-log
requirement all derive from one registry entry per tool. New tools:
`create_duty`, `list_duties`, `update_duty`, `pause_duty`, `resume_duty`,
`end_duty`, `delete_duty` (and, Phase 2, `show_duties`). Each is added to
`TOOL_NAMES` (INPUT layer, above) so dispatch and logging typecheck.

## PWA layer (`pwa/src/`)

Per `docs/plans/pwa-type-safety.md`, every new boundary needs a parser + tests:

- **Response parser** (`pwa/src/api/endpoints.ts`): `parseDutyRow` over
  `DutyRowSchema`; duty fields added to the task response parser.
- **IDB decode** (`pwa/src/idb/decode.ts`): a `duties` store decoder that
  repairs/quarantines like the task decoder, including the recurrence-shape check
  it already does for tasks (`pwa/src/idb/decode.ts:88`). Retire the dead
  `task_type: 'recurring'` migration (`decode.ts:18`) — the concept it stubbed is
  now a real table.
- **Pending ops** (`pwa/src/api/pendingOps.ts`): typed duty ops
  (`duty.create`, `duty.update`, `duty.setStatus`, `duty.delete`) added to the
  discriminated pending-op union, with temp-id rebinding for `MintedDutyId` just
  like tasks.
- **Form parser** (`pwa/src/domain/`): a `parseDutyForm` branding the duty
  editor's raw inputs (title, rrule, dtstart, timezone, catch_up) at submit,
  mirroring `parseTaskForm`.
- **Local mutations** (`pwa/src/domain/`): duty mutation guards, but **no local
  materialization** — the PWA never spawns instances (master Pillar 6). Duty
  create/edit/pause/delete are optimistic; instance appearance is server-driven.

## Cross-cutting: where `duty_id` shows up on tasks

The task-facing surfaces gain a read-only `duty_id` (and `occurrence_at`):
the MCP `Task` object shape (`docs/mcp-tools.md`), the REST task payloads, the
PWA `Task` row and its parsers, and the task card / detail views (a "from duty"
badge, Stage 8). These are additive, nullable fields — existing one-off tasks
carry `null` and every parser must accept `null`.

## Summary table

| Layer | File | Additions |
|---|---|---|
| INPUT | `shared/parse/ids.ts` | `DutyId`/`ParsedDutyId`/`MintedDutyId`, `parseDutyId` |
| INPUT | `shared/parse/enums.ts` | `DUTY_STATUSES`, `CATCH_UP_POLICIES`, parsers, `TOOL_NAMES` += duty tools |
| INPUT | `shared/parse/recurrence.ts` | `SeriesRrule`, `SeriesRruleParts`, `parseSeriesRrule`, anchor-zone-aware `occurrencesBetween`/`nextOccurrenceAfter`, `isSeriesExhausted` |
| INPUT | `shared/parse/time.ts` | `Timezone` brand — per-duty rule-expansion input **and** PWA display (Phase 1, Decision 4) |
| DOMAIN | `worker/src/domain/duty.ts` | `DutyTemplate`, `DutySeries` (incl. `timezone`, `nextOccurrenceAt`), `DutyDomain` union, `dutyFromRow` |
| DOMAIN | `worker/src/domain/Op.ts` | `duty.insert/update/update_cursor/orphan_open/delete` ops, `duty.exists` precheck, `DutyRow`/`DutyRowPatch` |
| DOMAIN | `worker/src/domain/ops/duty.ts` | `createDutyPlan`, `updateDutyPlan`, `setDutyStatusPlan`, `deleteDutyPlan`, `materializeDutyPlan` |
| ROW | `shared/schema.ts` | `duties` table (incl. `timezone`, `next_occurrence_at`), `tasks.duty_id`/`occurrence_at`, `action_log.duty_id`, unique index, `Duty` type |
| ROW/WIRE | `shared/wire/rows.ts` | `DutyRowSchema`, `TaskRowSchema` += duty fields |
| WIRE | `worker/src/wire/rest.ts` | duty route specs + bodies |
| WIRE | `worker/src/mcp.ts` | duty tool registry entries |
| PWA | `pwa/src/api/`, `idb/`, `domain/` | duty response/IDB/pending-op/form parsers, mutation guards |
