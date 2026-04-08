# worker/src/oauth.ts

Implements OAuth 2.1 with PKCE so external MCP clients (e.g. Claude.ai) can authorize against the worker without sharing the static `AUTH_TOKEN`. Authorization codes are stored in D1.

## Functions

**`handleOAuthRequest(request, db, env)`** — Routes all `/oauth/*` paths:

- `POST /oauth/register` — Dynamic client registration (RFC 7591). Accepts a client metadata object and returns a `client_id`.
- `GET /oauth/authorize` — Authorization endpoint. Validates `code_challenge` (PKCE), stores a short-lived authorization code in D1, and redirects to the client's `redirect_uri` with the code.
- `POST /oauth/token` — Token endpoint. Exchanges an authorization code + `code_verifier` for a bearer token. Verifies the PKCE challenge before issuing the token.
- `GET /oauth/meta` / `GET /.well-known/oauth-authorization-server` — Returns the OAuth server metadata document.
