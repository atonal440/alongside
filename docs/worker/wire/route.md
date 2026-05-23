# worker/src/wire/route.ts

Route-spec and wire parsing helpers for HTTP handlers.

## Types

**`HttpMethod`** — Supported REST method union.

**`WireSchema<T>`** — Valibot schema type used by route specs.

**`RouteSpec<Params, Query, Body>`** — Describes one route's method, pattern, path params, query, and body schemas.

**`ParsedRoute<TSpec>`** — Inferred parsed params and query values for a matched route spec.

## Functions

**`defineRoute(spec)`** — Preserves route spec generics for later registries.

**`parseWire(schema, input)`** — Runs a Valibot schema and returns shared `Result` validation output.

**`matchPath(pattern, pathname)`** — Matches colon-param route patterns such as `/api/tasks/:task_id` and returns raw decoded params, or `null` when the path does not match. Matching is exact by segment: trailing slashes, repeated slashes, and empty dynamic params do not normalize into valid routes.

**`parseRoute(spec, request, url)`** — Checks method/path, parses route params and query params through the spec schemas, and returns `null` for non-matches. Validation errors are returned before handlers can call the DB.
