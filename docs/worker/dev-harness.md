# worker/src/dev-harness.ts

Development-only helper for testing the iframe widget locally without a real MCP Apps host.

## Functions

**`getHarnessHtml()`** — Returns a standalone HTML page that simulates the MCP Apps host environment. It embeds the `/ui/active` widget in an iframe and provides a simple UI for sending `postMessage` JSON-RPC calls to the widget, making it easy to test widget interactions during local development without needing Claude.ai or another MCP client. Served at `GET /dev` (worker dev only — not deployed to production).
