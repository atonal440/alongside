# Stage 9 — Compiler Hardening, Shared-Type Cleanup, Docs Sweep

Part of `docs/plans/pwa-type-safety.md`. Prerequisites: stages 1–8 all merged. This is the closing stage; it also discharges the PWA-side obligations of the worker plan's step 11 ("Cleanup + compiler hardening" in `docs/plans/type-driven-safety.md`).

## Goal

Turn on the strict compiler flags for the PWA, tighten the remaining loose internal types, delete the shared compatibility aliases nothing uses anymore, and leave the documentation telling the true story.

## Steps

### 1. Compiler flags

Add `exactOptionalPropertyTypes: true` and `noUncheckedIndexedAccess: true` to `pwa/tsconfig.app.json` (and `pwa/tsconfig.sw.json` / `tsconfig.node.json` if they don't inherit). Fix the fallout properly, not with `!`:

- `noUncheckedIndexedAccess` known hot spots: `PROJECT_COLORS[hash % len]` in `pwa/src/utils/design.ts` (provably in-bounds — restructure with `?? fallback` or an `at()` helper); `TASK_FLOW_CHART[TASK_FLOW_CHART.length - 1]` in `pwa/src/utils/taskFlow.ts:175`; `Object.fromEntries`-built maps (`taskMap` in `EditView`, `remoteMap` in sync) — lookups become `T | undefined`, which is *correct*; handle the undefined.
- `exactOptionalPropertyTypes` will bite the optional-vs-null distinction in the stage-3/6 wire body and patch types — this is exactly the patch semantics the worker plan wanted the flag for (omitted ≠ explicit null). Make the intended semantics explicit in the types (`field?: T | null` where the wire genuinely distinguishes the three states).
- Apply the same flags to the vitest/test tsconfig so tests stay honest.

The worker tsconfig hardening is the worker plan's job; if it has already landed there, just confirm — don't touch worker config from this stage.

### 2. Internal type tightening (PWA)

- `pwa/src/context/reducer.ts`: `DELETE_LINK`'s `linkType: string` → `TaskLink['link_type']`; audit other action payloads for stringly fields (`SET_VIEW`'s `'session'` special case — keep behavior, consider a dedicated mapping).
- `pwa/src/context/reducer.ts:67-69`: delete the no-op `...(sessionId ? {} : {})` placeholder and either model session id in state or remove the dead read — investigate which (`actions.ts` comment claims it's "accessed directly in actions"; verify, likely stale).
- Sweep for remaining `as` casts in `pwa/src`: `grep -rn " as " pwa/src --include='*.ts*' | grep -v "as const"` — each survivor needs a justifying comment or a fix. Event-handler and DOM-typing casts in components are acceptable; data-shape casts are not.

### 3. Shared alias deletion (coordinate with the worker)

Preconditions to verify, then act:

- `grep -rn "TaskCreate\|TaskUpdate\|ProjectCreate\|ProjectUpdate" pwa/src worker/src` — stage 6 emptied the PWA side; check whether the worker's pending slices still import them. If the worker still uses any alias, delete only the unused ones and leave a note in **both** todo files (this plan's and `docs/plans/type-driven-safety-implementation-todo.md`); if nothing uses them, delete them from `shared/types.ts`.
- `PendingOp` was already moved in stage 4 — confirm `shared/types.ts` no longer mentions it.
- `pwa/src/types.ts` should end up re-exporting only what components actually consume (`Task`, `Project`, `TaskLink`) — or be deleted in favor of direct `@shared/schema` type imports if that's the smaller end state; pick one, apply consistently.
- Full worker verification after touching `shared/`: typecheck, test, `build:dry`.

### 4. Docs and conventions sweep

- Update `docs/pwa/overview.md` into the post-migration narrative: the four parsed boundaries, the durable/transient sync policy, the domain-mutation layer, the test architecture. Per `CLAUDE.md`'s documentation section, prefer one coherent narrative over per-file stubs; fold or refresh the stale per-file pages under `docs/pwa/` that the stages touched.
- `CLAUDE.md` + `AGENTS.md` (keep aligned, per repo rule): add the PWA's "parse at boundary, brand thereafter" rule alongside the worker's; update the Commands table (`npm --prefix pwa run test`); note that new PWA boundaries (new endpoint, new IDB store, new form) require a parser + tests as a matter of convention.
- Mark this plan's todo file complete; update the master plan's stage table statuses; check off the worker todo's "Future PWA Type System Notes" section if stage 5 didn't already.

### 5. Final verification

- `npm run verify` (full chain) green.
- Run the master plan's "End-to-End Verification" manual smoke list (six items) against `npm run dev`; record results in the PR.
- Bundle check: `npm --prefix pwa run build` output size vs pre-plan baseline (stages should have recorded deltas; total expected well under +15 KB gzipped given valibot was already shipped).

## Acceptance criteria

- Both flags on for app + tests; zero `@ts-ignore`/`@ts-expect-error` introduced outside `type-tests/`.
- No unjustified data-shape `as` casts in `pwa/src`.
- `shared/types.ts` contains only what worker or PWA actually import (toward the worker plan's target state: row aliases + nothing legacy).
- Docs and both todo files tell the current truth; smoke list passes.
