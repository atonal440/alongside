# shared/parse/enums.ts

Single source of truth for constrained string unions used by tasks, projects, links, MCP tools, and preferences.

## Constants

Exports `as const` arrays for task statuses, task types, defer kinds, link types, project statuses, tool names, user preference keys, internal preference keys, and all preference keys.

## Types

Exports branded enum types including `TaskStatus`, `TaskType`, `DeferKind`, `LinkType`, `ProjectStatus`, `ToolName`, `UserPreferenceKey`, `InternalPreferenceKey`, and `PreferenceKey`.

## Schemas And Parsers

Each enum has a Valibot schema and parser helper. `update_preference` should eventually accept only `UserPreferenceKey`; worker-owned keys such as `last_session_at` are intentionally separate.
