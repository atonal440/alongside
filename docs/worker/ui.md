# worker/src/ui.ts

Serves the embeddable iframe widget at `/ui/*`. These routes skip bearer-token auth and instead use HMAC signature verification so the widget can be embedded without exposing the auth token.

## Functions

**`handleUiRequest(request, url, db)`** — Routes requests under `/ui/`:

- `GET /ui/active` — Verifies the request signature, then returns the focused-tasks widget HTML (from `app-ui.ts`). The widget polls for updates and shows focused tasks (via `db.listFocusedTasks()`). Header says "Focused Tasks". The widget communicates back to the worker via `postMessage` JSON-RPC for real-time updates without a page reload.
- `GET /ui/tasks` — Returns the current focused tasks as JSON for widget polling.
- `POST /ui/complete/:id` — Parses `:id` through the UI route schema, then completes a task from the widget. Malformed IDs return HTTP 400 before DB access. Typed domain failures from completion are returned as JSON with the corresponding HTTP status, so invalid recurrence state or repeat completion does not fall through as an unhandled worker error.

Signature verification delegates to `verifySignature` from `sign.ts`.
