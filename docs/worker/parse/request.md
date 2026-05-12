# worker/src/parse/request.ts

Request parsing helpers for the type-safety migration.

## Functions

**`readJson(request)`** — Reads a request JSON body into `Result<unknown, ValidationError[]>`.

**`readForm(request)`** — Reads form data into `Result<FormData, ValidationError[]>`.

**`readQueryBool(searchParams, key)`** — Parses strict query booleans. Only `true` and `false` are accepted.

**`readRouteParam(params, key)`** — Extracts a required route parameter before handing it to a branded parser.
