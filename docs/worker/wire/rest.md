# worker/src/wire/rest.ts

REST route schemas for the PWA-facing API.

Exports reusable empty schemas, branded task/project path-param schemas, strict boolean query schemas for `include_log` and `dry_run`, and JSON body schemas for task, link, and project routes. The import route treats the request body as untrusted JSON at the route layer and deliberately hands it to the existing export-v1 import parser so validation detail paths stay under `payload`.

`RestRouteSpecs` is the registry consumed by `api.ts`. It covers task CRUD, task completion, task links, project CRUD, action-log, export, and import routes so handlers receive parsed params and query values, plus parsed JSON bodies where the route owns body validation.
