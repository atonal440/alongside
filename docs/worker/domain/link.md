# worker/src/domain/link.ts

Domain task-link shape.

## Types

**`TaskLinkDomain`** — Branded source task, target task, and link type.

**`TaskLinkLike`** — Minimal row-like shape used by graph helpers: `from_task_id`, `to_task_id`, and `link_type`.

## Functions

**`taskLinkFromParts(fromTaskId, toTaskId, linkType)`** — Parses raw link inputs into a `TaskLinkDomain`, with field-specific validation errors for malformed task ids or unknown link types.

**`findBlocksCycle(links)`** — Builds the directed `blocks` graph from row-like links and returns one cycle path when the graph is cyclic. `related` links are ignored because they do not affect readiness.
