# Stage 3 — Typed API Client

Part of `docs/plans/pwa-type-safety.md`. Prerequisites: stages 1–2.

## Goal

Replace the PWA's untyped `apiFetch` (which returns `unknown` on success and `null` on *any* failure) with a client that returns a discriminated `ApiResult<T>`, parses every response body against the shared row schemas, parses the worker's error bodies, and classifies failures as durable or transient. Call sites stop casting (`result as Task` disappears), but **queueing/retry policy does not change in this stage** — that is stage 5. This stage makes failure information available; stage 5 acts on it.

## Context for a cold start

- `pwa/src/api/client.ts` — `apiFetch(path, options, config)`: returns `null` if unconfigured, throws-and-catches any non-OK status into `null` (line 21), returns `res.json()` as `unknown` otherwise. `verifyApiConfig` pings `/` for the settings banner.
- Call sites: `pwa/src/context/actions.ts` (8 action creators, each `apiFetch(...)` + truthiness check + cast) and `pwa/src/api/sync.ts` (sync pulls + pending-op flush).
- Worker error contract (`worker/src/api.ts:12-16`): error responses are JSON `{ error: string }` or, for validation failures, `{ error: string, details: ValidationError[] }` with `ValidationError = { path, code, message }` from `shared/parse/primitives.ts`. Statuses: 400 validation, 404 not found, 409 conflict/invalid_transition/invariant_violation, 500 storage (`worker/src/domain/errors.ts`). Some legacy routes return hand-rolled `{ error: string }` 400s.
- Endpoints the PWA consumes today (verify against `worker/src/api.ts` — it is the source of truth, this list may drift): `POST /api/tasks` → task row; `PATCH /api/tasks/:id` → task row; `DELETE /api/tasks/:id` → confirmation; `POST /api/tasks/:id/complete` → `{ completed: Task, next?: Task }`; `GET /api/tasks/sync` → task rows; `GET /api/projects/sync` → project rows; `GET/POST/DELETE /api/tasks/links` → link rows / confirmations.
- Shared schemas from stage 2: `shared/wire/rows.ts` (`TaskRowSchema`, `ProjectRowSchema`, `TaskLinkRowSchema`, `parseTaskRow`, …). Result helpers: `shared/result.ts`.

## Design

### `ApiResult<T>` (new `pwa/src/api/result.ts`)

```ts
export type ApiErrorBody = { error: string; details?: ValidationError[] };

export type ApiResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'http'; status: number; body: ApiErrorBody }   // server answered, refused
  | { kind: 'network' }                                    // fetch threw / no connectivity
  | { kind: 'unconfigured' };                              // no apiBase set

export function isDurableFailure(r: ApiResult<unknown>): r is Extract<...> // http && 400 <= status < 500
export function isTransientFailure(r: ApiResult<unknown>): boolean         // network || http 5xx
```

Decision (from the master plan): 4xx is durable, network errors and 5xx are transient. `unconfigured` is its own kind — it currently masquerades as offline.

### Low-level request (rewrite `pwa/src/api/client.ts`)

`apiRequest(path, init, config, parseBody)`:

- Returns `{ kind: 'unconfigured' }` when `config.apiBase` is empty (preserves current short-circuit).
- On fetch throw → `{ kind: 'network' }`.
- On `!res.ok` → parse the body as `ApiErrorBody` leniently: malformed/non-JSON error bodies degrade to `{ error: 'HTTP <status>' }`. Never throw.
- On OK → run `parseBody(unknown)`; a parse failure is a **client-visible contract violation**: return it as `{ kind: 'http', status: 200, body: { error: 'unparseable response', details } }` and `console.error` the issues. The caller treats it as durable (do not queue a retry that can never succeed).

Keep `verifyApiConfig` (typed: `Promise<boolean>` is fine for a banner).

### Endpoint module (new `pwa/src/api/endpoints.ts`)

One typed function per endpoint, the only place paths/methods/response schemas are written:

```ts
export const api = {
  createTask:   (body: TaskCreateBody, c: ApiConfig) => apiRequest('/api/tasks', POST(body), c, parseTaskRow),
  updateTask:   (id: string, body: TaskUpdateBody, c) => …,
  deleteTask:   (id: string, c) => …,
  completeTask: (id: string, c) => …, // schema: { completed: TaskRowSchema, next: optional(TaskRowSchema) }
  syncTasks:    (c) => …,            // v.array(TaskRowSchema)
  syncProjects: (c) => …,
  listLinks:    (c) => …,
  createLink:   (body: LinkBody, c) => …,
  deleteLink:   (body: LinkBody, c) => …,
};
```

Request body types (`TaskCreateBody`, `TaskUpdateBody`, `LinkBody`) are defined here as **PWA-local wire types** mirroring what the code already sends (today they come from `shared/types.ts` `TaskCreate`/`TaskUpdate`; defining local equivalents now starts the migration off those aliases — stage 6 finishes it). Field names match the REST contract exactly.

### Call-site migration

Update `actions.ts` and `sync.ts` mechanically: replace each `apiFetch` call with the endpoint function and replace `if (result)` truthiness with `if (result.kind === 'ok')`. **Preserve current behavior**: any non-`ok` result takes the old `null` path (queue the op / report offline). The richer kinds are consumed in stage 5. This keeps the stage reviewable as "types in, behavior identical".

One intentional fix is allowed: `result !== null` vs `if (result)` inconsistencies collapse to `kind === 'ok'`, which is what both meant.

## Tests (`pwa/test/api/`)

Use `pwa/test/helpers/fetchStub.ts` and fixtures.

- `client.test.ts` — `apiRequest`: ok JSON parses through schema; non-OK with `{error, details}` body → `http` with parsed details; non-OK with HTML body → `http` with degraded message; fetch rejection → `network`; empty apiBase → `unconfigured` without calling fetch; OK-but-malformed body (task missing `id`) → durable contract-violation result, console.error called.
- `endpoints.test.ts` — table-driven per endpoint: correct method/path/body recorded by the stub; response parsed to typed rows; `completeTask` handles present and absent `next`.
- `result.test.ts` — `isDurableFailure` / `isTransientFailure` truth table (400, 404, 409, 422, 500, 503, network, unconfigured).
- Update nothing in `test/context/` yet — actions keep their behavior.

## Docs

Update `docs/pwa/api/` pages (client, new endpoints/result modules): the failure-kind contract, the durable/transient policy table, and the rule "all HTTP goes through `pwa/src/api/endpoints.ts` — no raw fetch in components/actions".

## Acceptance criteria

- `grep -rn "as Task\|as Project\|as TaskLink" pwa/src/api pwa/src/context` returns nothing (casts replaced by parsed results). `sync.ts` may still hold its title-matching logic — untouched until stage 5.
- `apiFetch` no longer exists (or survives only as a deprecated thin wrapper with no remaining callers).
- All pwa suites green; `npm run verify` green; PWA build size delta noted in the PR (schemas are shared with stage 2, expected small).
- Todo file updated, including the verified endpoint/response inventory (corrections to the list above are recorded for stages 4–5).
