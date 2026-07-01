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

Extend `materializeDutyPlan`: for each occurrence to spawn, assign a
`MintedTaskId` per template node, build the `task.insert` rows (all sharing the
same `occurrence_at` and `duty_id`, each stamped with its `template_node_key`),
then map template links to `link.upsert` ops. The whole graph is one plan → one D1
batch, so an occurrence's tasks and links commit atomically.

**Idempotent replay needs stable per-node ids.** A racing/duplicate graph
materialization must not point links at freshly-minted ids while the widened unique
index no-ops the repeated inserts — the `link.upsert` would then reference tasks
that were never inserted (FK failure / dangling link). So node ids must be
*stable across replays*, one of:

- **(preferred) Deterministic ids:** derive each node's id from
  `(duty_id, occurrence_at, template_node_key)` (e.g. `t_` + a short hash), so a
  replay re-derives the identical ids and both the `task.insert` (index no-op) and
  the `link.upsert` (same endpoints) are idempotent. No random `nanoid` for duty
  instances.
- **(alternative) Resolve-then-emit:** before building link ops, look up existing
  instance ids for this `(duty_id, occurrence_at)` and reuse them for present
  nodes; only mint for missing ones.

Idempotency index: widen `UNIQUE(duty_id, occurrence_at)` to
`(duty_id, occurrence_at, template_node_key)`. Add a `template_node_key` column to
`tasks`. **Every duty instance gets a non-null key** — including the Phase 1
single-node case (use a stable default, e.g. `'main'`); `NULL` is reserved for
one-off (non-duty) tasks only. This matters because SQLite treats `NULL` as
distinct in unique indexes, so a nullable key on duty instances would let repeated
single-task materialization insert duplicates. Backfill Phase 1 instances with the
default key when the column is added, and update Stage 4's benign-conflict handling
to the wider key.

### 4. Catch-up with graphs

`catch_up: 'all'` spawns the full graph per missed occurrence; `next` collapses
to one graph at the latest occurrence. The orphan rule (`00` §3) carries over
directly: the single bulk `duty.orphan_stale { id, before: latest }` op
(`WHERE duty_id=:id AND status='pending' AND occurrence_at < :latest`) detaches
**every task of every prior open occurrence** in one statement — while the
`< latest` bound excludes the current occurrence's just-spawned graph — and it
nulls only `duty_id`/`occurrence_at`, so orphaned graphs keep their inter-task
links. No new per-occurrence orphan machinery is needed; it stays bounded
regardless of how many occurrences or nodes are open. (`deleteDutyPlan` uses
`duty.orphan_all` — every instance, any status.) Test that an orphaned graph
occurrence retains its internal `blocks` links.

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
