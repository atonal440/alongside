# Stage 2 — Shared Row Schemas

Part of `docs/plans/pwa-type-safety.md`. Prerequisite: stage 1 (test harness). **This is the only stage that edits worker code.**

## Goal

Move the field-level row schemas that already exist in the worker's import pipeline into `shared/wire/rows.ts`, so the PWA (stages 3 and 8) can parse server responses and IndexedDB rows against the exact same definitions the worker uses to validate imports. **Strictly relocation — no schema semantics change.** The shared schemas validate fields (id format, enum membership, ISO timestamps, RRULE syntax, text bounds); they do **not** enforce cross-field invariants, and this stage must not add any (see Sharp edges).

## Context for a cold start

- `worker/src/wire/importPayload.ts` defines `ProjectRowSchema`, `TaskRowSchema`, `TaskLinkRowSchema`, `ActionLogRowSchema`, and composes them into `ImportV1Schema` / `parseImport`. Validation is **field-level only**: branded IDs (`shared/parse/ids.ts`), enum membership (`shared/parse/enums.ts`), ISO timestamps (`shared/parse/time.ts`), RRULE syntax via `RruleSchema`, and bounded text (max-length constants at the top of the file).
- **Cross-field invariants are not in these schemas.** Rules like `defer_kind === 'until'` ⇔ `defer_until` present, recurrence requires `due_date`, and done-tasks-can't-be-focused are enforced downstream by `taskFromRow` in `worker/src/domain/task.ts` (see its defer/focus/recurrence error paths). They stay there. The PWA gets cross-field protection from stage 6 (writes go through guarded mutations) and stage 8 (IDB decode adds PWA-local cross-field checks mirroring `taskFromRow`).
- **The legacy `snoozed_until` translation lives *inside* the current `TaskRowSchema`**: `defer_kind`/`defer_until` are optional entries, `snoozed_until` is accepted, and a `v.transform` normalizes legacy rows to the current defer shape. That tolerance is import-specific — REST responses and post-v3-migration IDB rows always carry `defer_kind`/`defer_until` — so it must **not** move into the shared canonical schema.
- `shared/` already hosts the parser toolkit (`shared/parse/`, `shared/brand.ts`, `shared/result.ts`) and is consumed by both worker and PWA via the `@shared` alias. There is no `shared/wire/` directory yet.
- The PWA bundles via Vite; the worker bundles via wrangler. Both already resolve `valibot` — but confirm the worker's vitest alias setup (`worker/vitest.config.ts` aliases `valibot` into `worker/node_modules`) still resolves modules that now live under `shared/`.

## Steps

1. **Inventory before moving.** Read `worker/src/wire/importPayload.ts` fully. What moves: the field schemas for task/project/link rows and their max-length constants. What stays in the worker: the legacy `snoozed_until` tolerance + normalization transform, `ActionLogRowSchema` (the PWA doesn't need it), the preference record schema, `ImportV1Schema`, and `parseImport`.
2. **Create `shared/wire/rows.ts`** with:
   - The bounds constants (`TASK_TITLE_MAX` etc.) and the title-schema helper.
   - `taskRowEntries` — the exported `v.object` entries map for the **current canonical task row shape**: `defer_kind: DeferKindSchema` and `defer_until: v.nullable(IsoDateTimeSchema)` as required keys, **no** `snoozed_until` entry, no normalization transform.
   - `TaskRowSchema = v.pipe(v.object(taskRowEntries), v.transform((row): Task => ({ ...row })))`, plus `ProjectRowSchema` and `TaskLinkRowSchema` moved as-is, and inferred output types (`ParsedTaskRow`, …).
   - Convenience parsers in the house style — `parseTaskRow(input: unknown): Result<ParsedTaskRow, ValidationError[]>` etc. — using the same valibot-issue→`ValidationError` mapping as `shared/parse/primitives.ts`.
   - `shared/wire/index.ts` re-exporting the module.
3. **Assignability guard.** The parsed output types must remain structurally assignable to the Drizzle row types so PWA state/IDB can store parsed rows as `Task`/`Project`/`TaskLink` (brands are assignable to their base primitives). Add a compile-time assertion:
   ```ts
   const _assertTask: (r: ParsedTaskRow) => Task = r => r;
   ```
   If a field mismatches, fix the schema's output shape, not the row type.
4. **Repoint the worker.** `worker/src/wire/importPayload.ts` imports `ProjectRowSchema`/`TaskLinkRowSchema`, the bounds constants, and `taskRowEntries` from `@shared/wire/rows` (mirror however `@shared/parse` is aliased in the worker tsconfig). Its import task schema becomes a locally-composed `ImportTaskRowSchema`: spread `taskRowEntries`, override `defer_kind`/`defer_until` to optional, add the `snoozed_until` entry, and keep the existing normalization transform verbatim. Import behavior must be bit-identical; the existing worker import tests are the proof.
5. **Worker verification.** Run `npm --prefix worker run typecheck && npm --prefix worker run test` — the existing import/wire suites must pass unchanged. Then `npm --prefix worker run build:dry` (`wrangler deploy --dry-run`): the `CLAUDE.md` testing note calls this out for changes touching shared modules, because wrangler's bundler catches resolver issues typechecks miss. Record the reported bundle size before/after in the PR description; expected delta ≈ 0.
6. **PWA smoke test.** Add `pwa/test/shared/rows.test.ts`, **field-level cases only** (the schemas have no cross-field checks — do not write tests expecting them):
   - `parseTaskRow` accepts a fixture task from `pwa/test/helpers/fixtures.ts` (this keeps the fixtures honest; if defaults fail, fix the fixtures).
   - Rejects: bad id format (`task_123`), unknown `status`, malformed `updated_at`, overlong title, invalid RRULE string in `recurrence`, malformed `defer_until` datetime, missing `defer_kind` (required in the canonical shape).
   - One happy + one reject case each for `parseProjectRow` / `parseTaskLinkRow`.
7. **Docs.** Create `docs/shared/wire.md` (match the `docs/shared/` pattern) describing the contract: one **field-level** schema per persisted row shape, consumed by worker import and PWA boundaries; the assignability guarantee; and an explicit pointer that cross-field invariants live in `worker/src/domain/task.ts` (`taskFromRow`) and, PWA-side, in stage 6/8 layers — not here. Update the `docs/worker/` page for `importPayload` if one exists.

## Sharp edges

- **Do not add cross-field checks to the shared schemas.** It is tempting (the master plan's pillars talk about defer atomicity), but adding them here would make the worker import pipeline and PWA response parsing reject rows the system currently accepts — a semantics change this relocation stage must not smuggle in. Cross-field enforcement is stage 6 (local writes) and stage 8 (IDB decode, quarantine) on the PWA, and `taskFromRow`/future D1 CHECKs on the worker.
- **Do not change wire field names or constraints.** If you discover the import schema is stricter than what the REST API actually returns, stop and record it in the todo file — stage 3 needs to know. Response parsing reuses these schemas, so a mismatch would make the PWA reject valid server data.
- valibot `v.object` strips unknown keys by default; that is the desired behavior for both import and response parsing. Do not switch to `strictObject`.
- Keep `shared/wire/` free of worker-only concepts (no `Plan`, no `AppError`) and free of DOM/React imports — it must load in workerd, node (vitest), and the browser.

## Acceptance criteria

- `shared/wire/rows.ts` exists; `worker/src/wire/importPayload.ts` defines no duplicate field schemas (only the legacy-tolerant import composition).
- Full worker verification green with **unchanged** import test expectations: typecheck, tests, `build:dry` (bundle delta noted).
- New `pwa/test/shared/rows.test.ts` green (field-level cases only); root `npm run verify` green.
- Todo file updated; any schema/API mismatches discovered are written down there.
