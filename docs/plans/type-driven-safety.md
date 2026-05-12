# Type-Driven Safety Plan (Worker)

## Context

Alongside today leans on TypeScript as a hint layer and on hand-written shape checks at a few boundaries. Drizzle row types (`Task`, `Project`, `TaskLink`, `ActionLog`) are reused for caller input, DB writes, MCP tool arguments, REST bodies, URL/path/query params, widget route params, OAuth form fields, and the export payload. That conflation means:

- ISO dates, timestamps, RRULEs, IANA timezones, nanoid keys, and the discrete enums (`status`, `task_type`, `defer_kind`, `link_type`) are all carried as plain `string` — there is no point in the program where the compiler knows a value has been validated.
- MCP and REST handlers reach the DB through chains of `as` casts (`args.recurrence as string | undefined`, `linkType as 'blocks' | 'related'`, `updates as Parameters<DB['updateTask']>[1]`). A malformed or hostile JSON-RPC client can push junk straight into D1.
- Order-of-operations bugs are easy: `update_task` lets a caller change `defer_until` without setting `defer_kind`; `importAll` skips its integrity check whenever the payload is small enough to fit one batch; `link_tasks` writes the row before confirming either endpoint task exists.
- Some public mutation surfaces are easy to forget because they are not JSON body handlers. The widget route `POST /ui/complete/:id`, OAuth authorize/token forms, and route/query params all need the same typed boundary treatment as REST and MCP.

Goal: introduce a single, layered type system in the worker where untrusted JSON, URL params, query params, form data, and imported rows are parsed once at the edge, internal code receives validated branded types, and illegal states fail to compile. The same architecture should later extend to the PWA, but that is out of scope for this first pass. This plan supersedes the existing `docs/plans/type-driven-safety.md`.

## Design Pillars

1. **Four layers, one direction.** Wire (`unknown` from JSON) → Input (parsed, branded) → Domain (discriminated unions of branded values) → Row (DB storage). Conversion functions cross layers; everything in between speaks the layer's vocabulary only.
2. **Brand or burn.** Every constrained string is a branded nominal type. DB write methods refuse to accept non-branded primitives at the type level.
3. **Parse, don't validate.** Every parser is `(input: unknown) => Result<Branded, ValidationError[]>`. Validators that return `boolean` are banned because they lose the proof.
4. **Specs are the source of truth.** Routes, MCP tools, preferences, and log policies are described once as typed registries. Exposed JSON schemas, dispatch, parsing, and action-log requirements are derived from those registries so drift fails typecheck.
5. **Operations are values.** Mutations are constructed as typed `Op<T>` objects, then executed by a single `apply` step. This lets order-sensitive flows (import, link-tasks, create-project-with-children) be expressed and tested without temporal coupling inside handlers.
6. **State transitions are explicit.** `DeferState`, `Recurrence`, `Focus`, and task lifecycle are discriminated unions, not loose nullable fields. Each transition is its own function with a precise input/output type.
7. **Errors are data.** Parsing, planning, and storage return typed error variants (`validation`, `not_found`, `conflict`, `invalid_transition`, `invariant_violation`, `storage`) that REST and MCP map exhaustively.

## Layer Map

```
┌─────────────────────────────────────────────────────────────┐
│ WIRE  (unknown JSON-RPC, URL path/query, forms, bodies)      │
│   parsed by: worker/src/wire route-specific parsers          │
└────────────────────────────┬────────────────────────────────┘
                             ▼  parse() : Result<Input, Err[]>
┌─────────────────────────────────────────────────────────────┐
│ INPUT (branded primitives + enum brands, no business shape) │
│   defined in: worker/src/parse/                              │
└────────────────────────────┬────────────────────────────────┘
                             ▼  toDomain()
┌─────────────────────────────────────────────────────────────┐
│ DOMAIN (discriminated unions; e.g. TaskDomain, ProjectDomain)│
│   defined in: worker/src/domain/                             │
│   operations:  worker/src/domain/ops/                        │
└────────────────────────────┬────────────────────────────────┘
                             ▼  toRow() at DB boundary only
┌─────────────────────────────────────────────────────────────┐
│ ROW (Drizzle $inferSelect / $inferInsert; nullable strings) │
│   defined in: shared/schema.ts                               │
│   consumed by: worker/src/storage/                           │
└─────────────────────────────────────────────────────────────┘
```

Every public entry point (`api.ts`, `mcp.ts`, `ui.ts`, `oauth.ts`, `importAll`) sits at the top of the diagram. Every DB call sits at the bottom. There is no allowed downward path that skips a layer.

## Library Choices

| Concern | Recommendation | Why |
| --- | --- | --- |
| Runtime schema + brands | **valibot** (`^1.x`) | Tree-shakeable (~1–4 KB used vs Zod's ~50 KB minified), first-class `brand()`, `pipe()` and `transform()` cover parse-not-validate, fits Workers 1 MB ceiling. Alternative: `zod` 4 mini if engineers already know Zod. |
| Result/Either | tiny inline helper in `shared/result.ts` | Adding `neverthrow` or `effect` is overkill; a 30-line discriminated union covers the worker. |
| RRULE | hand-rolled parser in `worker/src/parse/recurrence.ts` | `rrule.js` is ~70 KB and supports far more than we use; a typed FREQ/INTERVAL/BYDAY parser is ~80 lines and we control the surface. Revisit when BYDAY+BYMONTHDAY are needed. |
| Timezone | `Intl.supportedValuesOf('timeZone')` (ES2023, available in Workers) cached at module load | No 80 KB tz database needed for membership. For date math, use `Intl.DateTimeFormat` `formatToParts` — Temporal is not yet stable in Workers. |
| Test runner | **vitest** + `@cloudflare/vitest-pool-workers` | First-party Cloudflare integration, runs against `workerd` so D1 + bindings behave like prod. |
| Property-based testing | `fast-check` | Used for parser round-trips and RRULE/date invariants — small dep, optional. |
| ID generation | keep `nanoid@3` | Already in use; only wrap with brand. |
| Compiler strictness | `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` | Forces patch semantics to distinguish omitted fields from explicit `null`, and forces array/map/record lookups to handle missing values. Enable as part of the migration once the affected modules have typed parsers. |

No further runtime deps required. Total added bundle: ~3–5 KB minified worst case.

## File Layout

New files:

```
shared/
  result.ts                        Result<T,E>, ok, err, mapResult, all
  brand.ts                         Brand<T, K> nominal helper
  parse/
    primitives.ts                  IsoDate, IsoDateTime, NonEmptyString, etc.
    ids.ts                         TaskId, ParsedTaskId, MintedTaskId,
                                   ProjectId, ParsedProjectId, MintedProjectId,
                                   OAuthCode
    enums.ts                       TaskStatus, TaskType, DeferKind, LinkType,
                                   ProjectStatus, ToolName, UserPreferenceKey,
                                   InternalPreferenceKey, PreferenceKey
    time.ts                        IanaTimezone, parseIsoDate, parseIsoDateTime
    recurrence.ts                  Rrule, parseRrule, nextOccurrence
worker/src/
  parse/
    index.ts                       Re-export shared/parse + worker-specific
    request.ts                     readJson, readForm, readRouteParam,
                                   readQueryBool — turn Request -> unknown safely
  wire/
    route.ts                       typed RouteSpec for params/query/body
    rest.ts                        valibot schemas keyed by route
    mcp.ts                         valibot schemas keyed by tool name
    ui.ts                          widget route path/action schemas
    oauth.ts                       OAuth register/authorize/token schemas
    importPayload.ts               valibot schema for ExportPayload v1
  domain/
    errors.ts                      AppError union + response mapping helpers
    task.ts                        TaskDomain (discriminated), DeferState, Recurrence, Focus
    project.ts                     ProjectDomain
    link.ts                        TaskLinkDomain
    preference.ts                  UserPreference/InternalPreference key/value unions
    actionLog.ts                   ActionLogEntryDomain (ToolName-keyed)
    ops/
      task.ts                      createTask, completeTask, deferTask, …
      project.ts                   createProject, archiveProject, …
      link.ts                      linkTasks, unlinkTasks
      import.ts                    planImport(payload) -> Op[]
    Op.ts                          Op<T> discriminated union (Insert/Update/Delete/Batch)
  storage/
    codec.ts                       rowFromTask / taskFromRow / linkRow / …
    apply.ts                       apply(op): runs D1 statements in one batch
    db.ts                          (existing DB class; methods become thin wrappers)
worker/test/
  parse/*.test.ts                  unit tests for parsers
  wire/*.test.ts                   wire-layer schema acceptance/rejection
  domain/*.test.ts                 state-transition tests
  e2e/*.test.ts                    full request flow over @cloudflare/vitest-pool-workers
  fixtures/                       golden export payloads, recurrence tables
vitest.config.ts                   workspace config
```

Renamed/significantly changed:

- `worker/src/db.ts` — keeps `class DB` as the storage surface, but every write method takes `Op<T>` or branded inputs only. `parseNextOccurrence` moves to `shared/parse/recurrence.ts` and gets typed.
- `worker/src/api.ts`, `worker/src/mcp.ts`, `worker/src/ui.ts`, `worker/src/oauth.ts` — become thin: parse with valibot, hand parsed input to a domain op, render the result.
- `shared/types.ts` — `TaskCreate` / `TaskUpdate` get split into wire (loose) and input (branded) variants; the worker wire variant lives in `worker/src/wire/`, the input variant in `worker/src/domain/`. Because the PWA currently imports these aliases, either keep compatibility aliases until the PWA migration or move equivalent local wire aliases into `pwa/src/types.ts` before removing the shared exports.

## Branded Primitives and Parsers

`shared/brand.ts`:

```ts
declare const BRAND: unique symbol;
export type Brand<T, K extends string> = T & { readonly [BRAND]: K };
```

`shared/result.ts`:

```ts
export type Result<T, E> =
  | { ok: true; value: T }
  | { ok: false; error: E };
export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });
// + map, andThen, all (collects all errors, not first), unwrapOr.
```

`ValidationError` is a struct with `path: string[]`, `code: string`, `message: string`. `all` aggregates so a 400 response can list every field.

`shared/parse/primitives.ts` (valibot-backed):

| Brand | Constraint | Parser |
| --- | --- | --- |
| `IsoDate` | `/^\d{4}-\d{2}-\d{2}$/` AND the date round-trips through `Date.UTC` | `parseIsoDate` |
| `IsoDateTime` | full ISO-8601 with `Z` or `±HH:MM`, round-trips through `new Date().toISOString()` | `parseIsoDateTime` |
| `IanaTimezone` | member of `Intl.supportedValuesOf('timeZone')` | `parseIanaTimezone` |
| `NonEmptyString<MaxLen>` | trimmed length ∈ [1, MaxLen] | `parseNonEmpty(max)` |
| `BoundedString<MaxLen>` | length ≤ MaxLen | `parseBounded(max)` |
| `PositiveInt<Max>` | integer ≥ 1, ≤ Max | `parsePositiveInt(max)` |
| `PositiveFiniteNumber` | finite, > 0, ≤ Max | `parsePositiveFinite(max)` |

`shared/parse/ids.ts`:

| Brand | Format | Notes |
| --- | --- | --- |
| `TaskId` | `^t_[0-9A-Za-z_-]{5,}$` | matches `addTask`'s `t_${nanoid(5)}` |
| `ProjectId` | `^p_[0-9A-Za-z_-]{5,}$` | matches `createProject`'s `p_${nanoid(5)}` |
| `OAuthCode` | `^[0-9A-Za-z_-]+$`, length 32 | OAuth one-shot codes |

`TaskId` / `ProjectId` are the general validated ID brands accepted by lookups. Use separate source brands when the distinction matters:

```ts
export type ParsedTaskId = TaskId & Brand<string, 'ParsedTaskId'>;
export type MintedTaskId = TaskId & Brand<string, 'MintedTaskId'>;
```

`parseTaskId()` returns a `ParsedTaskId`; `mintTaskId()` wraps `nanoid` and returns a `MintedTaskId`. Most existing-domain operations accept the wider `TaskId`, but create/insert planners can require `MintedTaskId` when the caller must not choose storage IDs. If this distinction is not used in a given planner, do not claim it is enforced — source brands only buy safety where function signatures require them.

`shared/parse/enums.ts` exports brands rather than raw union strings:

```ts
export type PendingTaskStatus = Brand<'pending', 'TaskStatus'>;
export type DoneTaskStatus = Brand<'done', 'TaskStatus'>;
export type TaskStatus = PendingTaskStatus | DoneTaskStatus;
export type TaskType   = Brand<'action' | 'plan', 'TaskType'>;
export type DeferKind  = Brand<'none' | 'until' | 'someday', 'DeferKind'>;
export type LinkType   = Brand<'blocks' | 'related', 'LinkType'>;
export type ProjectStatus = Brand<'active' | 'archived', 'ProjectStatus'>;
export type ToolName   = Brand<typeof TOOL_NAMES[number], 'ToolName'>;
export type UserPreferenceKey = Brand<typeof USER_PREFERENCE_KEYS[number], 'UserPreferenceKey'>;
export type InternalPreferenceKey = Brand<typeof INTERNAL_PREFERENCE_KEYS[number], 'InternalPreferenceKey'>;
export type PreferenceKey = UserPreferenceKey | InternalPreferenceKey;
```

`TOOL_NAMES`, `USER_PREFERENCE_KEYS`, and `INTERNAL_PREFERENCE_KEYS` are single source-of-truth `as const` arrays. `update_preference` accepts only user keys (`sort_by`, `urgency_visibility`, `kickoff_nudge`, `session_log`, `interruption_style`, `planning_prompt`), while worker-owned keys such as `last_session_at` are internal-only. The MCP tool registry, action log, and preferences store all consume the same unions so a misspelled tool or preference key fails the compile.

### Recurrence

`shared/parse/recurrence.ts`:

```ts
export type Rrule = Brand<string, 'Rrule'>;
export type RruleParts = {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: PositiveInt<999>;  // capped to prevent absurd values
};
export function parseRrule(input: unknown): Result<{ rrule: Rrule; parts: RruleParts }, ValidationError[]>;
export function nextOccurrence(parts: RruleParts, from: IsoDate): IsoDate;
```

`parseRrule` returns *both* the brand and the parsed parts in one shot — callers never need to re-parse the string. `nextOccurrence` takes the parsed parts and an `IsoDate` and returns an `IsoDate`; it cannot be called with a raw string at all.

`db.ts:47` `parseNextOccurrence(rrule: string, fromDate: string): string | null` disappears — its callers receive a `Recurrence` discriminated union from the domain layer (see below) and dispatch on it.

## Discriminated Domain Types

`worker/src/domain/task.ts`:

```ts
export type DeferState =
  | { kind: 'none' }
  | { kind: 'someday' }
  | { kind: 'until'; until: IsoDateTime };

export type Focus =
  | { kind: 'unfocused' }
  | { kind: 'focused'; until: IsoDateTime };

export type Recurrence =
  | { kind: 'one_shot' }
  | { kind: 'recurring'; rrule: Rrule; parts: RruleParts; firstDue: IsoDate };

export interface TaskBase {
  id: TaskId;
  title: NonEmptyString<200>;
  notes: BoundedString<10_000> | null;
  taskType: TaskType;
  projectId: ProjectId | null;
  dueDate: IsoDate | null;
  recurrence: Recurrence;
  kickoffNote: BoundedString<2_000> | null;
  sessionLog: BoundedString<10_000> | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

export type PendingTaskDomain = TaskBase & {
  lifecycle: 'pending';
  status: PendingTaskStatus;
  defer: DeferState;
  focus: Focus;
};

export type DeferredPendingTaskDomain = PendingTaskDomain & {
  defer: Exclude<DeferState, { kind: 'none' }>;
};

export type DoneTaskDomain = TaskBase & {
  lifecycle: 'done';
  status: DoneTaskStatus;
  defer: { kind: 'none' };
  focus: { kind: 'unfocused' };
};

export type TaskDomain = PendingTaskDomain | DoneTaskDomain;
```

The exact factoring can differ, but `TaskDomain` should be a lifecycle union rather than a single interface with an independent `status` field. The important part is that transition functions accept the narrowest state they can operate on: `completeTaskPlan(task: PendingTaskDomain, ...)`, `deferTaskPlan(task: PendingTaskDomain, ...)`, `focusTaskPlan(task: PendingTaskDomain, ...)`, and `reopenTaskPlan(task: DoneTaskDomain | DeferredPendingTaskDomain, ...)`. Completing an already-done task or focusing a done task should be a type error in internal code and an `invalid_transition` error at the wire boundary.

Four crucial properties:

1. **Recurrence requires a `firstDue`.** The row representation lets `recurrence != null && due_date == null` exist; the domain type does not. `taskFromRow` rejects that combination and returns an error to the boundary that produced it (`importAll`, primarily). This eliminates the silent NaN walk inside `parseNextOccurrence` (db.ts:47) when `recurrence` is set but `due_date` is missing.
2. **Defer-state and focus are atomic.** A `DeferState` of `until` cannot exist without `until: IsoDateTime`. Setting `defer_until` without `defer_kind` is unrepresentable. `Focus` is the same shape, eliminating the `focused_until` ↔ `null` ambiguity.
3. **Domain has no nullable timestamps where they are not meaningful.** `created_at` / `updated_at` are non-null `IsoDateTime`. `due_date` is `IsoDate | null` (one-shot tasks legitimately omit it); when `recurrence.kind === 'recurring'` it must be present because the recurring variant carries `firstDue` of type `IsoDate`.
4. **Task lifecycle gates transitions.** Mutation planners operate on `PendingTaskDomain` or `DoneTaskDomain`, not a generic row-shaped task. There is no internal path that can complete an already-done task, defer a done task, or focus a non-pending task without first performing an explicit reopen transition.

Analogous shapes:

- `ProjectDomain` — `status: ProjectStatus`, `kickoffNote: BoundedString<2000> | null`, etc.
- `TaskLinkDomain` — `{ from: TaskId; to: TaskId; linkType: LinkType }`. `from === to` is rejected by the parser, and `planLink` rejects new `blocks` edges that would create a cycle in the dependency graph.
- `ActionLogEntryDomain` — `{ toolName: ToolName; taskId: TaskId | null; ... }`. `task_id` is `null` only when the tool is one of the "no task" tools (`create_project`, `update_preference`, etc.); a small `ToolName -> RequiresTaskId` map enforces this.
- `PreferenceEntry` / `PreferenceDomain` — key-specific values, split into user preferences and internal worker preferences. For example, `last_session_at` is `InternalPreferenceKey` with an `IsoDateTime` value; `urgency_visibility` is `UserPreferenceKey` with `'show' | 'hide'`.
- `AppError` — `{ kind: 'validation' | 'not_found' | 'conflict' | 'invalid_transition' | 'invariant_violation' | 'storage'; ... }`. Planners and storage return this instead of throwing strings; REST and MCP map it exhaustively.

## Wire Schemas

`worker/src/wire/mcp.ts` defines one valibot schema per tool, keyed by the canonical tool-name list:

```ts
import * as v from 'valibot';
import { TaskIdSchema, IsoDateSchema, RruleSchema, ... } from '../parse';

export const McpSchemas = {
  add_task: v.object({
    title: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
    notes: v.optional(v.pipe(v.string(), v.maxLength(10_000))),
    due_date: v.optional(IsoDateSchema),
    recurrence: v.optional(RruleSchema),
    task_type: v.optional(v.picklist(['action', 'plan'])),
    project_id: v.optional(ProjectIdSchema),
    kickoff_note: v.optional(v.pipe(v.string(), v.maxLength(2_000))),
  }),
  // …one per tool…
} as const satisfies Record<typeof TOOL_NAMES[number], v.BaseSchema<any, any, any>>;
```

The `satisfies` clause ensures every declared tool has a schema; missing entries fail the typecheck. In the implementation, prefer a single typed `ToolRegistry` that contains the tool name, exposed MCP `inputSchema`, runtime parser, handler, and action-log policy; derive `TOOLS`, `TOOL_NAMES`, `McpSchemas`, and dispatcher cases from that registry. This prevents four parallel lists from drifting. `handleToolCall` switches on the parsed result, not on `args.foo as Type`. Three useful side-effects:

- `mcp.ts:418-427` (`add_task`) stops accepting `args.recurrence` as raw `string | undefined`; valibot has already parsed it to `Rrule | undefined` with the `RruleParts` bundled.
- `mcp.ts:471-478` (`focus_task`) refuses non-finite `hours` and caps the upper bound (the current `Date.now() + hours * 3600000` will silently produce `NaN`/`Invalid Date` if `hours` is a string or `Infinity`).
- `mcp.ts:456-462` (`update_task`) stops accepting arbitrary spread args; the schema rejects unknown keys.

`worker/src/wire/rest.ts` does the same for REST. Schemas are reused — the REST and MCP wire schemas share a common `TaskCreateBody` and `TaskUpdateBody` to keep semantics aligned.

REST and UI routes should be declared with typed route specs so path params and query params are parsed with the same rigor as JSON bodies:

```ts
export type RouteSpec<Params, Query, Body> = {
  method: HttpMethod;
  pattern: URLPattern;
  params: v.BaseSchema<unknown, Params, any>;
  query: v.BaseSchema<unknown, Query, any>;
  body: v.BaseSchema<unknown, Body, any>;
};
```

Examples:

- `/api/tasks/:task_id` parses `task_id` as `TaskId`, not `string`.
- `/api/export?include_log=true` parses `include_log` as a strict boolean query value; unknown values are rejected instead of treated as false.
- `/ui/complete/:task_id` parses `task_id` through `worker/src/wire/ui.ts` before it can call `completeTaskPlan`.
- OAuth authorize/token form fields are parsed through `worker/src/wire/oauth.ts`, including `redirect_uri`, `state`, `code_challenge`, `code_challenge_method`, and `code_verifier`.

`worker/src/wire/importPayload.ts` defines the full export-v1 schema:

```ts
export const ImportV1Schema = v.object({
  version: v.literal(1),
  exported_at: IsoDateTimeSchema,
  projects: v.array(ProjectRowSchema),
  tasks: v.array(TaskRowSchema),
  links: v.array(TaskLinkRowSchema),
  preferences: PreferenceRecordSchema,
  action_log: v.optional(v.array(ActionLogRowSchema)),
});
```

`TaskRowSchema` validates *every field*: id format, enum membership, ISO date format on `due_date`/`defer_until`/`focused_until`/timestamps, RRULE syntax, `defer_kind === 'until' ⇒ defer_until !== null`. `PreferenceRecordSchema` validates key-specific values, not merely `Record<string, string>`, and `ActionLogRowSchema` validates the tool-name/task-id relationship through the tool registry log policy. This replaces the structure-only `validateExportPayload` (db.ts:614-624) and the FK-only `validatePayloadIntegrity` (db.ts:585-612); both move into a single `parseImport(payload)` function that runs unconditionally — eliminating the "skipped when payload is small" hole at db.ts:562-564.

The valibot schema also handles the legacy `snoozed_until` translation currently in db.ts:509-529: a `transform()` step rewrites the old shape into the new defer fields before integrity checks run, so the rest of the pipeline only ever sees post-migration data.

## Ops, Order of Operations

The core idea for order-of-operations safety is to make mutations *values*, not method calls:

```ts
// worker/src/domain/Op.ts
export type Op =
  | { kind: 'task.insert';   row: TaskRow }
  | { kind: 'task.update';   id: TaskId; patch: TaskRowPatch }
  | { kind: 'task.delete';   id: TaskId }
  | { kind: 'project.insert'; row: ProjectRow }
  | { kind: 'project.update'; id: ProjectId; patch: ProjectRowPatch }
  | { kind: 'project.delete'; id: ProjectId }
  | { kind: 'link.upsert';   row: TaskLinkRow }
  | { kind: 'link.delete';   from: TaskId; to: TaskId; linkType: LinkType }
  | { kind: 'pref.upsert';   entry: PreferenceEntry }
  | { kind: 'log.insert';    entry: ActionLogRow }
  | { kind: 'wipe' };

export type Plan = { ops: Op[]; assertions: PreCheck[] };
```

`worker/src/storage/apply.ts` is the only code that translates `Op`s into D1 statements. It runs them in dependency order (`wipe`, `project.insert`, `task.insert`, `link.upsert`, `pref.upsert`, `log.insert`) and in a single `d1.batch` for atomicity when size permits; the chunked fallback is only ever used after the assertions in the plan have passed.

This restructures the most error-prone flows:

| Flow | Today | New |
| --- | --- | --- |
| `complete_task` for recurring task (db.ts:155-186) | Two sequential writes (`update` → `addTask`) inside one async function; if the second fails the task is "done" with no successor. | `completeTaskPlan(task)` returns `{ ops: [update-original, insert-next] }`; `apply` runs both in one D1 batch. |
| `create_project` + assign tasks (mcp.ts:488-505) | Insert project, then N independent `updateTask` calls. Partial failure leaves orphans. | `createProjectPlan(input, taskIds)` returns one insert + N updates as a single plan. |
| `link_tasks` (mcp.ts:530-553) | Inserts the link row before confirming either task exists. | `planLink({from, to, linkType})` first asserts both ids resolve via a single `SELECT id FROM tasks WHERE id IN (?,?)`; for `blocks`, it also asserts that adding the edge would not create a cycle; then it emits `link.upsert`. |
| `importAll` (db.ts:477-582) | Wipe + chunked inserts; integrity check only runs above 100 statements. | `planImport(parsedPayload)` always validates, builds a `Plan`, and the same `apply` runs it. |
| `defer_task` with `kind='someday'` but `until` provided (mcp.ts:444-453) | Silently drops `until`. | Wire schema rejects `until` when `kind !== 'until'` via discriminated `v.variant`. |

Because `Op` is a discriminated union, `apply.ts` has an exhaustive switch checked by `never`. Adding a new mutation forces every layer to acknowledge it.

### Pre-checks

`assertions: PreCheck[]` are read-only D1 queries that the planner attaches when an op cannot be self-contained — e.g., "task `t_x7k2m` must exist before this link" or "this `blocks` edge does not create a cycle". `apply` runs all checks first, fails fast on any mismatch, and only then issues the batch.

This is the type-level fix for the "is this a get-then-act race?" question: a plan's pre-checks declare what reality it expects; `apply` enforces it; no handler can reorder the steps because the handler does not see them individually. Failed checks return typed `AppError` variants (`not_found`, `conflict`, `invalid_transition`) so endpoint error mapping is exhaustive instead of string-based.

## Storage Codec

`worker/src/storage/codec.ts`:

```ts
export function taskFromRow(row: TaskRow): Result<TaskDomain, ValidationError[]>;
export function rowFromTask(domain: TaskDomain): TaskRow;
// Plus a patch codec:
export function rowPatchFromTaskPatch(patch: TaskPatch): TaskRowPatch;
```

Two important properties:

1. `taskFromRow` is *fallible* — any row that violates a domain invariant (recurrence without due_date, defer_until with kind=none, malformed timestamp) is reported, not silently coerced. This guards reads from D1 against drift introduced by older code paths or manual edits.
2. `rowFromTask` is *total* — given a valid `TaskDomain`, the row is always valid by construction.

The codec is the only place where the worker reads or writes the storage shape. Existing methods on `class DB` get rewritten to operate on rows internally but expose domain types externally:

```ts
async getTask(id: TaskId): Promise<TaskDomain | null>;
async listReadyTasks(projectId?: ProjectId): Promise<TaskDomain[]>;
async apply(plan: Plan): Promise<void>;
```

Per-field setter methods (`deferTask`, `clearDeferTask`, etc.) disappear; callers go through `apply(plan)` instead. This collapses the `updateTask` (db.ts:220-242) field-by-field copy and removes the line `if (updates.status === 'done') throw new Error(...)` in favor of: there is no way to mark a task done except via `completeTaskPlan`, full stop.

### Database Check Constraints

Types and parsers protect the worker, but D1 should still reject impossible rows when data comes from old code, manual edits, or a future bypass. After the parser/codecs land, add a compatible schema migration (likely a SQLite table-rebuild migration) and keep `worker/schema.sql` plus `shared/schema.ts` aligned with constraints for:

- enum fields: task/project status, task type, defer kind, link type.
- `task_links.from_task_id <> task_links.to_task_id`.
- `recurrence IS NULL OR due_date IS NOT NULL`.
- `(defer_kind = 'until') = (defer_until IS NOT NULL)` unless product semantics intentionally allow elapsed timed deferrals to keep `defer_until`.
- `defer_kind != 'none'` implies `focused_until IS NULL`.
- non-empty required titles after trimming, if SQLite expression support is acceptable for D1.

These checks are defense in depth, not a replacement for typed parsing. If a check would make legacy imports fail, the import transform must normalize the legacy shape before rows reach storage.

## Endpoint Rewrites

Each handler becomes a four-line shape: read → parse → plan → apply. This applies to JSON bodies, path params, query params, widget route params, and OAuth form data.

```ts
// worker/src/api.ts (excerpt)
if (method === 'POST' && path === '/api/tasks') {
  const json = await readJson(request);
  const parsed = parse(McpSchemas.add_task, json);
  if (!parsed.ok) return jsonError(400, parsed.error);
  const plan = planCreateTask(parsed.value);
  const task = await db.apply(plan);
  return json(task, 201);
}
```

`mcp.ts:tools/call` becomes:

```ts
const params = parseMcpParams(body.params);
if (!params.ok) return mcpError(body.id, -32602, params.error);
const schema = McpSchemas[params.value.name];
const args = parse(schema, params.value.arguments);
if (!args.ok) return mcpError(body.id, -32602, formatErrors(args.error));
const result = await handleTool(params.value.name, args.value, db);
```

`handleTool` is now a discriminated dispatcher whose input type for each case is `v.InferOutput<typeof McpSchemas[Name]>` — branded all the way down. The big `case 'add_task': ... args.recurrence as string` block disappears.

`ui.ts` gets the same treatment even though it is small. `POST /ui/complete/:task_id` parses `task_id` as a `TaskId`, loads a `PendingTaskDomain`, calls `completeTaskPlan`, and maps `not_found` / `invalid_transition` to JSON errors. It must not keep a direct `db.completeTask(rawString)` escape hatch.

## OAuth Inputs

`worker/src/oauth.ts` is a smaller surface, but it gets the same treatment:

- Wire schemas in `worker/src/wire/oauth.ts` for the three flows (`/oauth/register`, `/oauth/authorize` GET+POST, `/oauth/token`).
- `redirect_uri` becomes a brand `RedirectUri` parsed via the `URL` constructor with an https/http allowlist; that prevents the current "echoed back from the DB unchecked" pattern.
- `client_id`, `state`, `code_challenge`, `code_verifier`, and `OAuthCode` get bounded-string brands so form values cannot be blindly cast out of `FormData`.
- `code_challenge_method` becomes a brand `'S256'` — the legacy empty-string fallback gets explicit handling.
- `/oauth/token` checks the parsed `client_id` and `redirect_uri` against the stored code record before deleting/issuing, and returns typed `invalid_grant` / `unsupported_grant_type` errors rather than generic string errors.

## Action Log Discipline

`db.logAction` (db.ts:417-432) takes `tool_name: string`. After the refactor it takes `ToolName` (brand). Callers can only obtain a `ToolName` by going through the tool dispatcher, so an action-log entry for a tool that doesn't exist cannot be written. The typed tool registry also owns each tool's log policy:

```ts
type LogPolicy =
  | { kind: 'requires_task'; taskId: TaskId }
  | { kind: 'project_or_global' }
  | { kind: 'none' };
```

The action-log planner consumes `LogPolicy`, not ad-hoc handler strings. A tool that requires a task cannot emit a log with `task_id: null`, and a no-task tool cannot accidentally attach an unrelated task ID. The action log widget consumes the same union, removing the "did I match the right tool name?" guesswork in the PWA.

## Time, Timezones, and `now()`

`db.ts:43-44` `now()` returns plain `string`. Replace with:

```ts
// shared/parse/time.ts
export function nowUtc(): IsoDateTime;
export function nowInTz(tz: IanaTimezone): { date: IsoDate; dateTime: IsoDateTime };
```

`now()` callers in DB code accept the new type immediately. Domain functions that need calendar-day reasoning (mostly recurrence) take an `IanaTimezone` parameter, currently sourced from a user-preference brand. There is no UI for picking a tz yet, so the default is `'UTC'`, but the parameter exists so a future tz preference doesn't require re-plumbing.

This eliminates the silent DST drift hazard already present in `parseNextOccurrence` (db.ts:47-76).

## Tests

`vitest.config.ts` adds `@cloudflare/vitest-pool-workers` and a `worker/test` directory. Test suites by file:

- `parse/primitives.test.ts` — round-trip on `IsoDate`, `IsoDateTime`, including:
  - Calendar boundaries: `2026-02-29` rejected (not a leap year), `2024-02-29` accepted.
  - `2026-02-31`, `2026-13-01`, `tomorrow`, empty string all rejected.
  - `IsoDateTime` must include either `Z` or an offset; bare local strings rejected.
- `parse/recurrence.test.ts` — accept `FREQ=DAILY`, `FREQ=WEEKLY;INTERVAL=2`; reject typos (`FREQ=WEEKL`), non-numeric INTERVAL, INTERVAL=0, negative, > 999.
- `parse/time.test.ts` — `parseIanaTimezone` accepts `America/Los_Angeles`, rejects `PDT`, `etc/utc` (case-sensitive), empty string.
- `parse/ids.test.ts` — `parseTaskId` accepts `t_x7k2m`, rejects `T_X7K2M`, `task_x7k2m`, `t_` (too short).
- `wire/route.test.ts` — route params and query params are parsed: invalid task IDs reject before handlers run; `include_log=yes` and `dry_run=1` reject unless explicitly supported.
- `wire/mcp.test.ts` — golden table per tool: a valid args object and 3–5 invalid variants per tool, each asserting the rejected fields.
- `wire/mcp-registry.test.ts` — the tool registry derives `TOOLS`, schemas, handler names, and log policies from one source. This can be mostly compile-time, backed by a tiny runtime assertion that the exposed tool list matches `TOOL_NAMES`.
- `wire/ui.test.ts` — `POST /ui/complete/:task_id` rejects malformed IDs and maps already-done tasks to an `invalid_transition` response.
- `wire/oauth.test.ts` — rejects malformed `redirect_uri`, unsupported `code_challenge_method`, missing/oversized `code_verifier`, and token requests whose `redirect_uri` or `client_id` do not match the stored code.
- `wire/import.test.ts` — accepts a real exported payload (fixture), rejects payloads where status/task_type/defer_kind are unknown enums, where defer_until is set with kind=none, where recurrence is set without due_date.
- `domain/task.test.ts`:
  - `completeTaskPlan` on a one-shot task produces a single update op.
  - `completeTaskPlan` on a recurring task produces update + insert ops referencing the right `firstDue` carry-forward.
  - `completeTaskPlan` on a done task returns `invalid_transition`; internal type fixtures use `@ts-expect-error` to prove a `DoneTaskDomain` cannot be passed where `PendingTaskDomain` is required.
  - `taskFromRow` rejects every drift case enumerated in the domain section.
  - Legacy recurring task conversion: a row that resembles a pre-refactor recurring task converts cleanly.
- `domain/link.test.ts` — self-links reject; `blocks` edges that create longer dependency cycles reject; `related` edges do not participate in cycle checks.
- `domain/preference.test.ts` — public `update_preference` rejects internal keys such as `last_session_at`; internal callers can write `last_session_at` only with an `IsoDateTime`.
- `domain/import.test.ts`:
  - Duplicate task IDs in payload → error before any ops are planned.
  - Task referencing missing project → error.
  - Link referencing missing task → error.
  - Duplicate `(from, to, link_type)` → error.
  - These run on the *atomic* path too (current code skips integrity check there).
- `e2e/api.test.ts`, `e2e/mcp.test.ts` — boot the worker via vitest-pool-workers; assert that:
  - `POST /api/tasks` with `due_date: 'tomorrow'` returns 400 with a field path.
  - `PATCH /api/tasks/:id` cannot set `status: 'done'`.
  - `POST /api/tasks/links` with unknown task IDs returns 400, no row inserted.
  - `POST /api/tasks/links` with a cycle-causing `blocks` edge returns 409, no row inserted.
  - MCP `focus_task` with `hours: 'NaN'` is rejected.
  - `/ui/complete/not-a-task-id` rejects before touching D1.
  - `POST /api/import` with a junk payload rejects without wiping the DB (seed first, then attempt bad import, then verify rows still present).

### Property-based tests (optional but cheap)

`fast-check` covers two invariants:

1. `taskFromRow(rowFromTask(t)) ≅ t` for arbitrary `TaskDomain`s built by a generator.
2. `nextOccurrence(parts, d) > d` for any valid `(parts, d)`; iterating it `n` times advances by `n × interval` units.

## Verification

Add a top-level `npm run verify`:

```json
"verify": "npm --prefix worker run typecheck && npm --prefix worker run test && npm --prefix worker run build:dry && npm --prefix pwa run typecheck && npm --prefix pwa run build"
```

Where `worker/package.json` gains:

```json
"test": "vitest run",
"build:dry": "wrangler deploy --dry-run"
```

`verify` is the single command CI and humans run before merging.

Type-level fixtures that rely on `@ts-expect-error` are part of `npm --prefix worker run typecheck`. The migration is not complete until `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` are enabled and `verify` passes with both flags.

## Migration Plan

Done as a series of small, mergeable PRs so each step is reviewable on its own:

1. **Scaffolding** — add `shared/result.ts`, `shared/brand.ts`, `shared/parse/`, `worker/src/wire/`, `worker/src/domain/`, `worker/src/storage/codec.ts`, but only as new code. Add `AppError`, route spec helpers, type-level test fixtures, vitest config, and a smoke test. No existing handler changes. *Goal:* land the new files behind no caller; verify build size is still healthy.
2. **Recurrence vertical slice** — move `parseNextOccurrence` to `shared/parse/recurrence.ts` typed against `Rrule`. Rewrite `db.completeTask` to consume `Recurrence` and `PendingTaskDomain`. Update `addTask`/`updateTask` boundary code to parse and reject malformed RRULEs. Add the recurrence and lifecycle tests. *Goal:* prove the layered approach on the highest-risk path before touching everything.
3. **Defer + Focus + lifecycle** — replace `defer_kind` / `defer_until` / `focused_until` with the `DeferState` / `Focus` domain types behind the same boundary parsers. Rewrite `deferTask`, `clearDeferTask`, `focusTask`, and the readiness query helpers (`notDeferredCondition` at db.ts:80-88). *Goal:* eliminate the inconsistent-state class of bugs (`defer_until` set with `kind='none'`, focus on done tasks, etc.).
4. **Op plan + apply** — introduce `Op`, `Plan`, `PreCheck`, `apply`, and typed `AppError` returns. Rewrite `completeTask` and `createProject + assign tasks` to plans. Add the plan tests. *Goal:* prove the order-of-ops machinery on two paths.
5. **Links + graph checks** — rewrite link/unlink through `TaskLinkDomain` and `planLink`, including endpoint existence checks, self-link rejection, and `blocks` cycle rejection. *Goal:* prevent dependency graph states that can make tasks permanently blocked.
6. **Wire schemas (REST + UI)** — add `worker/src/wire/rest.ts`, `worker/src/wire/ui.ts`, and route specs for path/query/body parsing. Rewrite `api.ts` and the mutating route in `ui.ts` route by route. Add REST/UI e2e tests. *Goal:* one HTTP boundary fully covered, including non-JSON route params.
7. **Wire schemas (MCP registry)** — add `worker/src/wire/mcp.ts` and a typed tool registry that derives exposed tool definitions, runtime schemas, dispatch, and log policy. Rewrite `mcp.ts`. *Goal:* the other boundary fully covered. After this PR, no `as` cast on `args.*` remains in `mcp.ts`.
8. **Import pipeline** — replace `validateExportPayload` + `validatePayloadIntegrity` + `importAll` body with `parseImport` + `planImport` + `apply`. *Goal:* close the "small payload skips integrity" hole and the silent legacy-translation behavior.
9. **OAuth + preferences + action log brands** — replace ad-hoc validation in `oauth.ts`; introduce `ToolName`, `UserPreferenceKey`, `InternalPreferenceKey`, key-specific preference values, and log-policy types; thread them through `logAction` and `setPreference`. *Goal:* OAuth inputs, the action-log widget, and prefs are typed end to end.
10. **Database constraints** — add the compatible D1/SQLite migration for enum and invariant `CHECK`s after import transforms and codecs are in place. Update `worker/schema.sql` and `shared/schema.ts` where Drizzle can represent the same constraints. *Goal:* D1 rejects impossible rows even if a future code path bypasses the domain layer.
11. **Cleanup + compiler hardening** — remove now-unused exports from `shared/types.ts` only after the PWA has compatibility aliases, enable `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess`, update `docs/` per the project's per-file doc convention, and update `CLAUDE.md` / `AGENTS.md` with the new "parse at boundary, brand thereafter" rule.

Each step keeps the worker green; `npm run verify` passes after every PR.

## Non-Goals

- **PWA refactor** — out of scope. The PWA will continue to send today's wire shapes; the worker accepts them after parsing. Once the worker is stable the PWA can import `shared/parse/*` and reuse the same brands client-side. Note explicitly: PWA reducers and IndexedDB modules keep their current row-shaped types until a later plan addresses them. Do not break the PWA while cleaning up shared types: keep temporary compatibility aliases in `shared/types.ts`, or move PWA-local wire aliases into `pwa/src/types.ts` before removing `TaskCreate` / `TaskUpdate` / `ProjectUpdate`.
- **Wire-shape changes** — REST and MCP payloads keep their current JSON field names so existing clients (Claude.ai MCP, the PWA, any external scripts using REST) keep working. Only the *internal* types change.
- **Switching ORMs or DBs** — Drizzle + D1 stay. Row types remain `$inferSelect`.
- **Full RRULE compliance** — BYDAY, BYMONTHDAY, COUNT, UNTIL stay unsupported in v1. The parser is structured so adding them is contained.
- **Authentication redesign** — bearer-token + OAuth flow stays as is; only its inputs get parsed.

## Critical Files to Modify

| File | Change |
| --- | --- |
| `shared/schema.ts` | row schema remains the storage surface; add representable enum/check constraints when the D1 constraint migration lands |
| `shared/types.ts` | remove worker-facing `TaskCreate`/`TaskUpdate`/`ProjectUpdate` only after PWA compatibility aliases exist; keep exporting `PendingOp` and `Task`/`Project`/`TaskLink`/`ActionLog` row aliases |
| `shared/result.ts`, `shared/brand.ts`, `shared/parse/*` | new |
| `worker/src/wire/{route,rest,mcp,ui,importPayload,oauth}.ts` | new |
| `worker/src/domain/*` | new, including `errors.ts`, lifecycle task types, preference key/value unions, and log policy types |
| `worker/src/storage/{codec,apply}.ts` | new |
| `worker/src/db.ts` | rewrite to consume `Plan`s and emit `TaskDomain`/`ProjectDomain`; `now()`, `parseNextOccurrence`, `notDeferredCondition` move out |
| `worker/src/api.ts` | rewrite each route as parse→plan→apply |
| `worker/src/mcp.ts` | rewrite `handleToolCall` as a discriminated dispatcher derived from the typed tool registry |
| `worker/src/ui.ts` | parse widget route params through `wire/ui.ts`; remove direct raw-string mutation calls |
| `worker/src/oauth.ts` | parse + brand redirect_uri, code_challenge_method, code_verifier |
| `worker/schema.sql`, `worker/migrations/007_type_safety_checks.sql` | add DB check constraints once codecs/import transforms normalize legacy data |
| `worker/package.json` | add vitest, `@cloudflare/vitest-pool-workers`, valibot, fast-check; add `test` and `build:dry` scripts |
| `vitest.config.ts` (worker root) | new |
| `worker/tsconfig.json` | enable `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` during cleanup once affected code is typed |
| `docs/parse/`, `docs/wire/`, `docs/domain/`, `docs/storage/` | new doc files per the per-file convention in `CLAUDE.md` |
| `docs/plans/type-driven-safety.md` | replaced by this document |

## End-to-End Verification

Beyond `npm run verify`:

1. **Local smoke** — start worker + PWA via the repo-level runner, exercise:
   - Create task with `due_date: 'tomorrow'` via PWA — expect a friendly 400.
   - Create recurring task, complete it, observe the next instance is created in the same DB batch (check D1 logs).
   - Complete the same task twice through REST/MCP/UI — expect the second attempt to return `invalid_transition` and create no extra recurring successor.
   - Attempt to create a cycle with `blocks` links — expect a conflict and no new link row.
   - Export, edit the JSON to add a duplicate task id, import — expect a 400 with the duplicate's id named, DB unchanged.
   - Use `focus_task` from Claude.ai MCP — expect rejection of any non-finite hours, success on 1–24.
   - Hit `/ui/complete/not-a-task-id` — expect a typed validation error, not a DB lookup.
   - Try public `update_preference` with `last_session_at` — expect rejection because it is an internal preference key.
2. **Bundle size** — `wrangler deploy --dry-run` reports worker size; record before/after. Expected delta ≤ 8 KB for valibot + parsers.
3. **Regression** — run the action-log widget end-to-end; the registry/log-policy brands should not break its existing render.
4. **Migration safety** — import a real backup taken before this refactor; the legacy `snoozed_until` translation must still pass and the resulting DB must equal the pre-migration state on a spot check.
5. **PWA compatibility** — `npm --prefix pwa run typecheck && npm --prefix pwa run build` still pass after shared type cleanup.

## Open Questions for Review

1. Bundle ceiling — is the worker close enough to the 1 MB limit that 5–8 KB matters? If yes, swap valibot for hand-rolled parsers in `shared/parse/` and keep the brand types unchanged.
2. Should `apply(plan)` log every op into `action_log` automatically, instead of each tool handler calling `db.logAction`? It is a natural fit but changes the schema of the log (one row per op vs one row per tool call). Default in this plan is to leave `logAction` as an explicit op the planner emits.
3. PWA shared-code stance — keep parsers in `shared/parse/` and import them client-side later, or fork into `worker/src/parse/` only? Default in this plan is `shared/parse/` so the PWA can adopt incrementally without duplicating work.
4. DB constraints — include the table-rebuild `CHECK` migration in this refactor or land it immediately after the worker no longer writes legacy shapes? Default in this plan is to include it after import transforms/codecs are in place.
5. Minted-vs-parsed IDs — require `MintedTaskId` / `MintedProjectId` only for create/insert planners, or keep one `TaskId` / `ProjectId` brand everywhere? Default in this plan is to split the source brands only where a signature benefits from the distinction.
