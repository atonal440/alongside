# worker/src/index.ts

Entry point for the Cloudflare Worker. Exports the default `fetch` handler that receives every inbound HTTP request, handles CORS preflight, and routes to the appropriate sub-handler. Handles both the MCP and REST endpoints. 

## Exports / handlers

**`Env`** (interface) — Declares the Cloudflare Worker environment bindings: `DB` (D1 database instance) and `AUTH_TOKEN` (static bearer token string read from `wrangler.toml` vars).

**Default export** (Cloudflare Worker `fetch` handler) — Top-level router. Responds to `OPTIONS` with CORS headers that allow `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, and `OPTIONS`, then dispatches to:
- `handleOAuthRequest` for `/oauth/*` paths
- `handleApiRequest` for `/api/*` paths (requires auth)
- `handleMcpRequest` for `/mcp` (requires auth)
- `handleUiRequest` for `/ui/*` (signature-verified, no bearer auth)
- `getHarnessHtml` dev harness at `/dev`
- 404 for everything else

Auth is enforced by checking the `Authorization: Bearer <token>` header against `Env.AUTH_TOKEN` before delegating to API and MCP handlers.
