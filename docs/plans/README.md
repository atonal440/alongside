# Implementation plans

## Current product direction

- [Power-user todo model and LLM tools](power-user-todo.md): proposed task,
  temporal, hierarchy, reminder, timeblock, recurrence, reliability, and tool
  contracts. Start here for the expanded backend work.
- [Implementation checklist](power-user-todo-implementation-todo.md): ordered
  slices, acceptance criteria, verification, and cross-session handoff.

These are plans, not descriptions of implemented features. UI redesign is
deferred. Existing API/reference docs describe shipped contracts.

## Earlier plans and reusable foundations

- [Duties](duties.md) and [checklist](duties-implementation-todo.md): landed
  schema/timed recurrence foundations and earlier work orders. The new plan
  revises date semantics, occurrence identity, catch-up, lookahead, and archival.
- [Type-driven safety](type-driven-safety.md) and
  [checklist](type-driven-safety-implementation-todo.md): domain/op/parse
  architecture to retain and extend.
- [PWA type safety](pwa-type-safety.md) and
  [checklist](pwa-type-safety-implementation-todo.md): boundary parsing and
  local-first foundations to preserve through new sync contracts.
