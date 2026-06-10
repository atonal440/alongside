# Stage 3 — Typed API Client

Part of `docs/plans/pwa-type-safety.md`. Prerequisites: stages 1–2.

## Goal

Replace the PWA's untyped `apiFetch` (which returns `unknown` on success and `null` on *any* failure) with a client that returns a discriminated `ApiResult<T>`, parses every response body against the shared row schemas, parses the worker's error bodies, and classifies failures as durable or transient. Call sites stop casting (`result as Task` disappears), but **queueing/retry policy does not change in this stage** — that is stage 5. This stage makes failure information available; stage 5 acts on it.

## Context for a cold start

- `pwa/src/api/client.ts` — `apiFetch(path, options, config)`: returns `null` if unconfigured, throws-and-catches any non-OK status into `null` (line 21), returns `res.json()` as `unknown` otherwise. `verifyApiConfig` pings `/` for the settings banner.
- Call sites: `pwa/src/context/actions.ts` (8 action creators, each `apiFetch(...)` + truthiness check + cast) and `pwa/src/api/sync.ts` (sync pulls + pending-op flush).
- Worker error contract (`worker/src/api.ts:12-16`): error responses are JSON `{ error: string }` or, for validation failures, `{ error: string, details: ValidationError[] }` with `ValidationError = { path, code, message }` from `shared/parse/primitives.ts`. Statuses: 400 validation, 404 not found, 409 conflict/invalid_transition/invariant_violation, 500 storage (`worker/src/domain/errors.ts`). Some legacy routes return hand-rolled `{ error: string }` 400s.
- Endpoints the PWA consumes today (verify against `worker/src/api.ts` — it is the source of truth, this list may drift): `POST /api/tasks` → task row; `PATCH /api/tasks/:id` → task row; `DELETE /api/tasks/:id` → `{ ok: true }`; `POST /api/tasks/:id/complete` → `{ completed: Task, next?: Task }`; `GET /api/tasks/sync` → task rows; `GET /api/projects/sync` → project rows; `GET /api/tasks/links` → link rows; `POST /api/tasks/links` → `{ ok: true }` (201); `DELETE /api/tasks/links` → `{ ok: true }`. Note the confirmation endpoints: deletes and link writes return `{ ok: true }`, **not** rows — parsing them with row schemas would turn every successful write into a `contract` failure.
- Shared schemas from stage 2: `shared/wire/rows.ts` (`TaskRowSchema`, `ProjectRowSchema`, `TaskLinkRowSchema`, `parseTaskRow`, …). Result helpers: `shared/result.ts`.

## Design

### `ApiResult<T>` (new `pwa/src/api/result.ts`)

```ts
export type ApiErrorBody = { error: string; details?: ValidationError[] };

export type ApiResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'http'; status: number; body: ApiErrorBody }            // server answered, refused
  | { kind: 'contract'; status: number; issues: ValidationError[] } // server said OK but the body failed our schema
  | { kind: 'network' }                                             // fetch threw / no connectivity
  | { kind: 'unconfigured' };                                       // no apiBase set

export function isDurableFailure(r: ApiResult<unknown>): boolean   // (http && 400 <= status < 500) || contract
export function isTransientFailure(r: ApiResult<unknown>): boolean // network || (http && status >= 500)
```

Decision (from the master plan): 4xx is durable, network errors and 5xx are transient. `unconfigured` is its own kind — it currently masquerades as offline. `contract` is a distinct kind, **classified durable**: a response that parses wrong today will parse wrong on every retry, so queueing it would loop forever. It cannot be an `http` result — the status was 200, and the 4xx-based classifier would misfile it.

### Low-level request (rewrite `pwa/src/api/client.ts`)

`apiRequest(path, init, config, parseBody)`:

- Returns `{ kind: 'unconfigured' }` when `config.apiBase` is empty (preserves current short-circuit).
- On fetch throw → `{ kind: 'network' }`.
- On `!res.ok` → parse the body as `ApiErrorBody` leniently: malformed/non-JSON error bodies degrade to `{ error: 'HTTP <status>' }`. Never throw.
- On OK → run `parseBody(unknown)`; a parse failure is a **client-visible contract violation**: return `{ kind: 'contract', status: res.status, issues }` and `console.error` the issues. `isDurableFailure` returns true for it (do not queue a retry that can never succeed).

Keep `verifyApiConfig` (typed: `Promise<boolean>` is fine for a banner).

### Endpoint module (new `pwa/src/api/endpoints.ts`)

One typed function per endpoint, the only place paths/methods/response schemas are written:

```ts
const ConfirmationSchema = v.object({ ok: v.literal(true) }); // worker confirmation shape for deletes + link writes

export const api = {
  createTask:   (body: TaskCreateBody, c: ApiConfig) => apiRequest('/api/tasks', POST(body), c, parseTaskRow),
  updateTask:   (id: string, body: TaskUpdateBody, c) => …, // TaskRowSchema
  deleteTask:   (id: string, c) => …,                       // ConfirmationSchema
  completeTask: (id: string, c) => …,                       // { completed: TaskRowSchema, next: optional(TaskRowSchema) }
  syncTasks:    (c) => …,                                   // v.array(TaskRowSchema)
  syncProjects: (c) => …,                                   // v.array(ProjectRowSchema)
  listLinks:    (c) => …,                                   // v.array(TaskLinkRowSchema)
  createLink:   (body: LinkBody, c) => …,                   // ConfirmationSchema
  deleteLink:   (body: LinkBody, c) => …,                   // ConfirmationSchema
};
```

Request body types (`TaskCreateBody`, `TaskUpdateBody`, `LinkBody`) are defined here as **PWA-local wire types** mirroring what the code already sends (today they come from `shared/types.ts` `TaskCreate`/`TaskUpdate`; defining local equivalents now starts the migration off those aliases — stage 6 finishes it). Field names match the REST contract exactly.

### Call-site migration

Update `actions.ts` and `sync.ts` mechanically: replace each `apiFetch` call with the endpoint function and replace `if (result)` truthiness with `if (result.kind === 'ok')`. **Preserve current behavior**: any non-`ok` result takes the old `null` path (queue the op / report offline). The richer kinds are consumed in stage 5. This keeps the stage reviewable as "types in, behavior identical".

One intentional fix is allowed: `result !== null` vs `if (result)` inconsistencies collapse to `kind === 'ok'`, which is what both meant.

## Tests (`pwa/test/api/`)

Use `pwa/test/helpers/fetchStub.ts` and fixtures.

- `client.test.ts` — `apiRequest`: ok JSON parses through schema; non-OK with `{error, details}` body → `http` with parsed details; non-OK with HTML body → `http` with degraded message; fetch rejection → `network`; empty apiBase → `unconfigured` without calling fetch; OK-but-malformed body (task missing `id`) → `contract` result, console.error called.
- `endpoints.test.ts` — table-driven per endpoint: correct method/path/body recorded by the stub; response parsed with the schema each endpoint declares — row schemas where the worker returns rows, `ConfirmationSchema` for deletes and link writes (a stubbed `{ ok: true }` must yield `kind: 'ok'`, not `contract`); `completeTask` handles present and absent `next`.
- `result.test.ts` — `isDurableFailure` / `isTransientFailure` truth table (400, 404, 409, 422, 500, 503, contract, network, unconfigured; the two classifiers must be mutually exclusive and leave only `ok`/`unconfigured` unclassified).
- Update nothing in `test/context/` yet — actions keep their behavior.

## Docs

Update `docs/pwa/api/` pages (client, new endpoints/result modules): the failure-kind contract, the durable/transient policy table, and the rule "all HTTP goes through `pwa/src/api/endpoints.ts` — no raw fetch in components/actions".

## Acceptance criteria

- `grep -rn "as Task\|as Project\|as TaskLink" pwa/src/api pwa/src/context` returns nothing (casts replaced by parsed results). `sync.ts` may still hold its title-matching logic — untouched until stage 5.
- `apiFetch` no longer exists (or survives only as a deprecated thin wrapper with no remaining callers).
- All pwa suites green; `npm run verify` green; PWA build size delta noted in the PR (schemas are shared with stage 2, expected small).
- Todo file updated, including the verified endpoint/response inventory (corrections to the list above are recorded for stages 4–5).
