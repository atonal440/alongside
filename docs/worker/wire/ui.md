# worker/src/wire/ui.ts

Widget route schemas.

## Schemas

**`UiCompleteParamsSchema`** — Parses `/ui/complete/:task_id` params with the branded task ID parser.

**`UiRouteSpecs`** — Registry consumed by `ui.ts` for `POST /ui/complete/:task_id`. The handler rejects malformed task IDs before calling the DB while preserving the widget's existing JSON response shape for successful completion and domain errors.
