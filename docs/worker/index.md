# worker/src/index.ts

Entry point for the Cloudflare Worker. Exports the default `fetch` handler that receives every inbound HTTP request, handles CORS preflight, and routes to the appropriate sub-handler. Handles both the MCP and REST endpoints. 

## Exports / handlers

**`Env`** (interface) — Declares the Cloudflare Worker environment bindings: `DB` (D1 database instance), `AUTH_TOKEN` (the owner's static bearer token, a Worker secret) and the optional `OAUTH_CLIENTS` secret (pre-registered OAuth clients, see [[oauth|worker/src/oauth.ts]]).

**Default export** (Cloudflare Worker `fetch` handler) — Top-level router. Responds to `OPTIONS` with CORS headers, then dispatches to:
- `handleOAuthRequest` for `/oauth/*` paths
- `handleApiRequest` for `/api/*` paths (requires auth)
- `handleMcpRequest` for `/mcp` (requires auth)
- `handleUiRequest` for `/ui/*` (signature-verified, no bearer auth)
- `getHarnessHtml` dev harness at `/dev`
- 404 for everything else

The default export also has a `scheduled` handler (`scheduled.ts`, every 15 minutes) that materializes due duties (see [duty materialization](duties.md)) and purges expired OAuth codes and tokens.

Auth is enforced on the `Authorization: Bearer <token>` header before delegating to API and MCP handlers. `Env.AUTH_TOKEN` is accepted on every route. An access token issued by the OAuth server is accepted on `/mcp` and `/mcp/admin` only, and only while its client is still registered. A 401 carries a `WWW-Authenticate` header whose `resource_metadata` is the path-specific protected-resource document (`/.well-known/oauth-protected-resource/mcp`).
