# worker/src/ui.ts

Serves the embeddable iframe widget at `/ui/*`. These routes skip bearer-token auth and instead use HMAC signature verification so the widget can be embedded without exposing the auth token.

## Functions

**`handleUiRequest(request, db, env)`** — Routes requests under `/ui/`:

- `GET /ui/active` — Verifies the request signature, then returns the focused-tasks widget HTML (from `app-ui.ts`). The widget polls for updates and shows focused tasks (via `db.listFocusedTasks()`). Header says "Focused Tasks". The widget communicates back to the worker via `postMessage` JSON-RPC for real-time updates without a page reload.
- `GET /ui/active.json` — Returns the current focused tasks as JSON for widget polling.
- `GET /ui/action-log` — Returns the action log widget HTML.
- `GET /ui/action-log.json` — Returns recent action log entries as JSON.

Signature verification delegates to `verifySignature` from `sign.ts`.
