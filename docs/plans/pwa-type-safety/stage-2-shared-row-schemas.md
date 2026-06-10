# Stage 2 — Shared Row Schemas

Part of `docs/plans/pwa-type-safety.md`. Prerequisite: stage 1 (test harness). **This is the only stage that edits worker code.**

## Goal

Move the row-level valibot schemas that already exist in the worker's import pipeline into `shared/wire/rows.ts`, so the PWA (stages 3 and 8) can parse server responses and IndexedDB rows against the exact same definitions the worker uses to validate imports. Pure relocation plus thin re-exports — no schema semantics change.

## Context for a cold start

- `worker/src/wire/importPayload.ts` defines `ProjectRowSchema`, `TaskRowSchema`, `TaskLinkRowSchema`, `ActionLogRowSchema`, and composes them into `ImportV1Schema` / `parseImport`. The row schemas validate every field: branded IDs (`shared/parse/ids.ts`), enum membership (`shared/parse/enums.ts`), ISO timestamps (`shared/parse/time.ts`), RRULE syntax (`shared/parse/recurrence.ts`), bounded text, and cross-field invariants (e.g. `defer_kind === 'until'` ⇔ `defer_until` present, recurrence requires `due_date`).
- `shared/` already hosts the parser toolkit (`shared/parse/`, `shared/brand.ts`, `shared/result.ts`) and is consumed by both worker and PWA via the `@shared` alias. There is no `shared/wire/` directory yet.
- The PWA bundles via Vite; the worker bundles via wrangler. Both already resolve `valibot` (it is a dependency of each package) — but confirm the worker's vitest alias setup (`worker/vitest.config.ts` aliases `valibot` into `worker/node_modules`) still resolves modules that now live under `shared/`.

## Steps

1. **Inventory before moving.** Read `worker/src/wire/importPayload.ts` fully. Identify which schemas are pure row validation (move) versus import-pipeline-specific (stay): the legacy `snoozed_until` transform, `ImportV1Schema`, preference-record schema, and `parseImport` stay in the worker; `ActionLogRowSchema` stays too unless it has no worker-import-specific coupling (the PWA does not need it — keep the moved surface minimal: task, project, link).
2. **Create `shared/wire/rows.ts`** containing `TaskRowSchema`, `ProjectRowSchema`, `TaskLinkRowSchema` and their inferred output types (`ParsedTaskRow`, `ParsedProjectRow`, `ParsedTaskLinkRow` via `v.InferOutput`). Add convenience parsers in the house style — `parseTaskRow(input: unknown): Result<ParsedTaskRow, ValidationError[]>` etc. — using the same valibot-issue→`ValidationError` mapping helper as `shared/parse/primitives.ts` (`valibotIssueToValidationError`). Add `shared/wire/index.ts` re-exporting the module.
3. **Assignability guard.** The parsed output types must remain structurally assignable to the Drizzle row types so PWA state/IDB can store parsed rows as `Task`/`Project`/`TaskLink` (brands are assignable to their base primitives). Add a compile-time assertion in `shared/wire/rows.ts` or a type-test file:
   ```ts
   const _assertTask: (r: ParsedTaskRow) => Task = r => r;
   ```
   If a field mismatches (e.g. schema makes optional what the row declares nullable), fix the schema's output shape, not the row type.
4. **Repoint the worker.** `worker/src/wire/importPayload.ts` imports the row schemas from `@shared/wire/rows` (check the worker `tsconfig.json` paths/aliases — mirror however `@shared/parse` is referenced there) and deletes its local copies. Behavior must be identical; the import-specific `v.pipe` extensions (legacy transform, payload-level integrity) wrap the shared schemas rather than redefining them.
5. **Worker verification.** Run `npm --prefix worker run typecheck && npm --prefix worker run test` — the existing import/wire test suites are the proof the relocation changed nothing. Then `npm --prefix worker run build:dry` (`wrangler deploy --dry-run`): the `CLAUDE.md` testing note calls this out specifically for changes touching shared modules/dependencies, because wrangler's bundler catches resolver issues typechecks miss. Record the reported bundle size before/after in the PR description; expected delta ≈ 0.
6. **PWA smoke test.** Add `pwa/test/shared/rows.test.ts`: `parseTaskRow` accepts a fixture task from `pwa/test/helpers/fixtures.ts` (this also keeps the fixtures honest against the real schema — if defaults violate an invariant, fix the fixtures); rejects: bad id format, unknown status, `defer_kind: 'until'` with `defer_until: null`, `recurrence` set with `due_date: null`, malformed `updated_at`. A handful of table-driven cases per row type, mirroring `worker/test/` style.
7. **Docs.** Create `docs/shared/wire.md` (or extend `docs/shared/parse/` conventions — match whichever pattern `docs/shared/` uses) describing the module's contract: one schema per persisted row shape, consumed by worker import and PWA boundaries; note the assignability guarantee. Update `docs/worker/` page for `importPayload` if one exists.

## Sharp edges

- **Do not change wire field names or constraints.** If you discover the import schema is stricter than what the REST API actually returns (e.g. the API emits a field the schema doesn't know), stop and record it in the todo file — stage 3 needs to know. Response parsing reuses these schemas, so a mismatch would make the PWA reject valid server data.
- valibot `v.object` strips unknown keys by default; that is the desired behavior for both import and response parsing. Do not switch to `strictObject` here.
- Keep `shared/wire/` free of worker-only concepts (no `Plan`, no `AppError`) and free of DOM/React imports — it must load in workerd, node (vitest), and the browser.

## Acceptance criteria

- `shared/wire/rows.ts` exists; `worker/src/wire/importPayload.ts` contains no duplicate row schema definitions.
- Full worker verification green: typecheck, tests, `build:dry` (bundle delta noted).
- New `pwa/test/shared/rows.test.ts` green; root `npm run verify` green.
- Todo file updated; any schema/API mismatches discovered are written down there.
