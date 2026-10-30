# worker/src/oauth.ts

A single-owner OAuth 2.1 authorization server, so external MCP connectors (Claude.ai, Gemini, ...) can connect without ever holding `AUTH_TOKEN`. The owner approves a connection by typing `AUTH_TOKEN` on the authorize page; the client receives its own tokens. There are no user accounts.

## Handshake

1. The client sends the owner's browser to `GET /oauth/authorize` with `client_id`, an exact `redirect_uri`, `state`, and a PKCE `code_challenge` (S256).
2. The owner enters `AUTH_TOKEN` (compared in constant time). The server stores a one-minute, single-use code in D1 and redirects to `redirect_uri` with `code` and `state`.
3. The client calls `POST /oauth/token` with the code, the redirect URI, its PKCE verifier and its client credentials, and gets a one-hour access token plus a 90-day refresh token.
4. The client sends `Authorization: Bearer <access token>` to `/mcp` (or `/mcp/admin`).
5. When the access token expires the client posts the refresh token to `/oauth/token` (`grant_type=refresh_token`) and gets a new pair. Refresh tokens are single use; presenting a used one ends the whole chain.
6. `POST /oauth/revoke` ends a chain from either of its tokens.

## Routes

- `GET /.well-known/oauth-protected-resource` (also `/mcp` and `/mcp/admin` suffixes) — RFC 9728 document naming the real resource URL.
- `GET /.well-known/oauth-authorization-server` — RFC 8414 metadata.
- `POST /oauth/register` — RFC 7591 registration. Requires 1-10 `redirect_uris`, each https or loopback http. Creates a public client. Keeps at most 200 dynamic clients.
- `GET|POST /oauth/authorize` — consent page. An unknown client or unregistered redirect URI gets an error page, never a redirect. Public clients must send PKCE; `plain` is refused.
- `POST /oauth/token` — `authorization_code` and `refresh_token` grants. Client authentication by HTTP Basic or body (`client_secret_basic` / `client_secret_post`). Form or JSON bodies; parsed with `OAuthTokenBodySchema`.
- `POST /oauth/revoke` — RFC 7009.

All token and discovery responses carry `Access-Control-Allow-Origin: *`; token responses are `no-store`.

## Clients

**Dynamic** clients (Claude.ai) register themselves; they are public and stored in `oauth_clients`.

**Pre-registered** clients (Gemini, whose connector form has no registration step) live in the optional `OAUTH_CLIENTS` Worker secret, a JSON array:

```json
[{ "client_id": "gemini-1a2b3c4d", "name": "Gemini", "secret_sha256": "<hex>", "redirect_uris": ["https://vertexaisearch.cloud.google.com/oauth-redirect"] }]
```

They are confidential: the token endpoint requires the secret. PKCE is optional for them (Gemini's toggle is off by default) but is verified whenever the client sent a challenge.

To add one:

```sh
cd worker
npm run oauth:client -- gemini https://vertexaisearch.cloud.google.com/oauth-redirect
```

The script prints the client id and secret (paste both into the connecting app; the secret is shown once and is not stored) and the JSON entry containing only the secret's SHA-256. Add that entry to the array and set the whole secret with `npx wrangler secret put OAUTH_CLIENTS` or in the Cloudflare dashboard (Worker > Settings > Variables and Secrets). A secret can only be replaced as a whole, not appended to or read back. An unreadable value is ignored with a warning, which leaves only dynamic clients and `AUTH_TOKEN` working.

**Revoking a client** is removing it from `OAUTH_CLIENTS` (or its row from `oauth_clients`). Its tokens stop working on the next request, because the client is looked up every time an access token is used.

### Gemini connector form

Authorization URL `https://<worker>/oauth/authorize`, Token URL `https://<worker>/oauth/token`, the client id and secret from the script, any non-empty scope (e.g. `mcp`; the server grants `mcp` regardless), PKCE on or off, HTTP Basic on or off.

## Resource side

- **`verifyAccessToken(env, token)`** — true for a live access token whose client is still registered. Used by `index.ts` for `/mcp*` only; OAuth tokens never open `/api` or `/ui`.
- **`isOwnerToken(env, token)`** — constant-time `AUTH_TOKEN` check.
- **`protectedResourceMetadataUrl(url)`** — the `resource_metadata` URL for a 401's `WWW-Authenticate` header.
- **`purgeExpiredOAuth(db)`** — run from the cron: removes expired codes and tokens, and used refresh tokens after a seven-day replay-detection window.

## Scope

There is one scope, `mcp`, covering `/mcp` and `/mcp/admin` as before. It is recorded on every code and token so that a separate admin scope can be added later. Whatever a client requests, `mcp` is what it gets.

## Not done

No throttle on the authorize password (rely on a long random `AUTH_TOKEN`, or add a Cloudflare rate-limit rule on `/oauth/authorize`), and no screen for listing or revoking connections yet.

## See Also

- [[index|worker/src/index.ts]] — routes `/oauth/*` to `handleOAuthRequest` and applies the bearer check
- [wire schemas](wire/oauth.md) — token request schemas
- [[schema]] — `oauthCodes`, `oauthClients`, `oauthTokens`
- [[mcp-tools]] — what callers reach after connecting
