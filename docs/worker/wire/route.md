# worker/src/wire/route.ts

Route-spec and wire parsing scaffolding.

## Types

**`HttpMethod`** — Supported REST method union.

**`WireSchema<T>`** — Valibot schema type used by route specs.

**`RouteSpec<Params, Query, Body>`** — Describes one route's method, pattern, path params, query, and body schemas.

## Functions

**`defineRoute(spec)`** — Preserves route spec generics for later registries.

**`parseWire(schema, input)`** — Runs a Valibot schema and returns shared `Result` validation output.
