# Stage 9 — Task-Graph Duty Templates (Phase 2)

Part of `docs/plans/duties.md`. Prerequisites: Phase 1 complete (Stages 1–8).
This is the deferred, designed-in Phase 2 from the master plan. Read
`01-type-system.md`'s note that `DutyTemplate` was modeled as a degenerate
one-node graph so this stage is additive.

## Goal

Let a single duty spawn a **graph of linked tasks** each occurrence — the
"recurring sequence of blockers" from `alongside-ideas.md` (a checklist or
dependency chain per cycle). The type system already permits it; this stage
lights up the template storage, the graph materializer, and the surfaces.

## Context for a cold start

- Phase 1's `DutyTemplate` (`worker/src/domain/duty.ts`, Stage 3) is a single
  task's worth of template fields. Stage 3 deliberately shaped it as an implicit
  one-node graph so this widening is additive.
- Links are `task_links` (`shared/schema.ts:31-37`): `(from_task_id, to_task_id,
  link_type)` with `link_type ∈ {blocks, related}`. `link.upsert` /
  `link.delete` ops and the `link.blocks_acyclic` precheck already exist
  (`worker/src/domain/Op.ts:15,25-26`; type-driven-safety "Link Domain" slice).
- `materializeDutyPlan` (Stage 4) currently emits one `task.insert` +
  `duty.update`. Graph spawning emits N `task.insert` + M `link.upsert` +
  `duty.update`, all in one plan/batch.

## Steps

### 1. Template storage

Choose the lighter of two options and record the decision:

- **(A) A `duty_template_tasks` + `duty_template_links` pair** — normalized
  template graph, one row per template node/edge, FK to `duties`. Cleanest;
  matches the task/link tables' shape.
- **(B) A JSON template column on `duties`** — `template_graph text` holding a
  parsed-at-boundary JSON structure (`{ tasks: [...], links: [...] }`).
  Fewer tables, but reintroduces a stringly blob that must be schema-parsed on
  every read.

Lean: **(A)**, to stay consistent with "parse at the boundary, brand through the
core" — a JSON blob fights that. Add the tables to `shared/schema.ts` +
`schema.sql` + a migration. The single-task duty becomes a template with exactly
one node and no edges (migrate Phase 1 duties into this representation, or treat
"no template rows" as the implicit single node — decide and document).

### 2. Domain

- Widen `DutyTemplate` to `{ tasks: DutyTaskTemplate[]; links: DutyTemplateLink[] }`.
  `DutyTaskTemplate` carries a stable **local key** (e.g. `node_1`) so links can
  reference template nodes before real ids exist. `DutyTemplateLink` is
  `{ from: LocalKey; to: LocalKey; link_type: LinkType }`.
- `dutyFromRow` (now `dutyFromRows`, since it assembles a duty + its template
  rows) validates: non-empty task set, links reference existing local keys, the
  `blocks` subgraph is acyclic (reuse the acyclicity logic behind
  `link.blocks_acyclic`).

### 3. Graph materialization

Extend `materializeDutyPlan`: for each occurrence to spawn, mint a fresh
`MintedTaskId` per template node, build the `task.insert` rows (all sharing the
same `occurrence_at` and `duty_id`), then map template links to `link.upsert`
ops using the freshly minted ids. The whole graph is one plan → one D1 batch, so
an occurrence's tasks and links commit atomically.

Idempotency: the `UNIQUE(duty_id, occurrence_at)` index constrains one row per
(duty, occurrence) — but a graph has N tasks per occurrence. Widen the uniqueness
to `(duty_id, occurrence_at, template_node_key)` (add a `template_node_key`
column to `tasks`, nullable for one-off and single-node instances) so re-running
a graph spawn is still a no-op per node. Update Stage 4's benign-conflict handling
to the wider key.

### 4. Catch-up with graphs

`catch_up: 'all'` spawns the full graph per missed occurrence; `next` collapses
to one graph at the latest occurrence. The orphan rule (`00` §3) generalizes to
graphs: an *occurrence* is "open" if any of its instances is still pending, and a
still-open prior occurrence is orphaned **as a unit** — null `duty_id` +
`occurrence_at` on every task of that occurrence (keeping their inter-task links)
before spawning the fresh graph. Specify and test this precisely.

### 5. Surfaces

- MCP `create_duty` / `update_duty` gain an optional `template` argument (the
  task+link graph). Keep the single-task form as the default/degenerate case so
  existing callers are unaffected.
- REST duty bodies gain the template graph (parsed through shared schemas).
- PWA: the duty editor gains a minimal template-graph builder (add tasks, draw
  `blocks` edges). This can be a basic list-with-dependencies UI first; a visual
  graph editor is a follow-up.
- `show_duties` widget (if deferred from Stage 6) can render the template graph.

### 6. Tests

- Domain: a valid 3-node blocks-chain template round-trips; a cyclic template is
  rejected; a link to an unknown node key is rejected.
- Materialize: a graph duty spawns N tasks + M links atomically; idempotent under
  repeat; `next` vs `all` graph collapse; the wider unique key holds.
- Surfaces: create/edit a graph duty via MCP and REST; PWA optimistic create of a
  graph duty and its instances after sync.

## Acceptance criteria

- Full `npm run verify` passes across worker and PWA.
- A duty can spawn a linked task graph each occurrence, atomically and
  idempotently, with `next`/`all` catch-up semantics defined for graphs.
- Single-task duties still work unchanged (degenerate one-node case).
- Docs (`mcp-tools.md`, `api.md`, pwa/worker overviews) updated for template
  graphs.
- Check off Stage 9 in the implementation todo.
