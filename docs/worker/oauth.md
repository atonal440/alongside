# worker/src/oauth.ts

A single-owner OAuth 2.1 authorization server, so external MCP connectors (Claude.ai, Gemini, ...) can connect without ever holding `AUTH_TOKEN`. The owner approves a connection by typing `AUTH_TOKEN` on the authorize page; the client receives its own tokens. There are no user accounts.

## Handshake

1. The client sends the owner's browser to `GET /oauth/authorize` with `client_id`, an exact `redirect_uri`, `state`, and a PKCE `code_challenge` (S256).
2. The owner enters `AUTH_TOKEN` (compared in constant time). The server stores a one-minute, single-use code in D1 and redirects to `redirect_uri` with `code` and `state`.
3. The client calls `POST /oauth/token` with the code, the redirect URI, its PKCE verifier and its client credentials, and gets a one-hour access token plus a 90-day refresh token.
4. The client sends `Authorization: Bearer <access token>` to `/mcp` (or `/mcp/admin`).
5. When the access token expires the client posts the refresh token to `/oauth/token` (`grant_type=refresh_token`) and gets a new pair. Refresh tokens are single use; presenting a used one ends the whole chain. Claiming the old token and inserting the new pair happen in one batch, so a concurrent replay or revoke cannot be undone by a request already in flight.
6. `POST /oauth/revoke` ends a chain from either of its tokens.

## Routes

- `GET /.well-known/oauth-protected-resource` (also `/mcp` and `/mcp/admin` suffixes) — RFC 9728 document naming the real resource URL.
- `GET /.well-known/oauth-authorization-server` — RFC 8414 metadata.
- `POST /oauth/register` — RFC 7591 registration. Requires 1-10 `redirect_uris`, each https or loopback http. Creates a public client. At most 200 dynamic clients: room is made by dropping the oldest ones that never received a token, approved clients are never evicted, and registration returns 429 if every slot is approved.
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

A Worker secret can only be replaced whole and never read back, so `worker/scripts/oauth-client.mjs` keeps the list in `worker/.oauth-clients.json` (gitignored; it holds secret hashes, never secrets) and sets the secret from that file in one step, over stdin, so no JSON is ever pasted:

```sh
cd worker
npm run oauth:client -- add gemini https://vertexaisearch.cloud.google.com/oauth-redirect   # add --admin to allow mcp:admin
npm run oauth:client -- list
npm run oauth:client -- remove <client-id>
npm run oauth:client -- push      # re-set the secret from the file
```

`add` prints the client id and secret once (paste both into the connecting app; the secret is not stored) and then pushes. Every command takes `--dry-run`, and `add` and `remove` take `--no-push`. The file is the source of truth, so `push` overwrites the deployed secret with it; if clients were ever set another way, add them to the file first. The secret can also be set by hand in the Cloudflare dashboard (Worker > Settings > Variables and Secrets). An unusable value is ignored, with the reason in the Worker log (`wrangler tail`), which leaves only dynamic clients and `AUTH_TOKEN` working.

**Revoking a client** is removing it from `OAUTH_CLIENTS` (or its row from `oauth_clients`). Its tokens stop working on the next request, because the client is looked up every time an access token is used.

### Gemini connector form

Authorization URL `https://<worker>/oauth/authorize`, Token URL `https://<worker>/oauth/token`, the client id and secret from the script, any non-empty scope such as `mcp` (Gemini can't be granted `mcp:admin` unless its entry allows it), PKCE on or off, HTTP Basic on or off.

## Resource side

- **`checkAccessToken(env, token, scope)`** — `ok`, `invalid` or `insufficient_scope` for a live access token whose client is still registered. Used by `index.ts` for `/mcp*` only; OAuth tokens never open `/api` or `/ui`. `requiredScopeFor(path)` and `bearerChallenge(url)` supply the scope and the `WWW-Authenticate` value.
- **`isOwnerToken(env, token)`** — constant-time `AUTH_TOKEN` check.
- **`protectedResourceMetadataUrl(url)`** — the `resource_metadata` URL for a 401's `WWW-Authenticate` header.
- **`purgeExpiredOAuth(db)`** — run from the cron: removes expired codes and tokens, and used refresh tokens after a seven-day replay-detection window.

## Scopes

- `mcp` opens `/mcp`. This is what a client gets when it asks for nothing, or only for scopes the server doesn't know (such as `offline_access`).
- `mcp:admin` opens `/mcp/admin` and also `/mcp`.

A token that lacks the scope for the path (or whose pre-registered client has since been narrowed in `OAUTH_CLIENTS`) gets `403` with `WWW-Authenticate: Bearer error="insufficient_scope", scope="mcp:admin", resource_metadata=...`. Every `401` also names the scope the path needs, and each protected-resource document lists its own `scopes_supported`, so a connector pointed at `/mcp/admin` asks for `mcp:admin` by itself. The authorize page says when admin tools are being requested. The granted scope is stored on the code and every token, and a refresh keeps it.

What a client may be granted: dynamic clients can ask for either (the owner sees and approves it on the authorize page); pre-registered clients get `mcp` only unless their `OAUTH_CLIENTS` entry lists `"scopes": ["mcp", "mcp:admin"]` (`npm run oauth:client -- ... --admin`). Asking for a scope a client isn't allowed returns `invalid_scope`. `AUTH_TOKEN` itself still opens everything.

## Not done

No throttle on the authorize password (rely on a long random `AUTH_TOKEN`, or add a Cloudflare rate-limit rule on `/oauth/authorize`), and no screen for listing or revoking connections yet.

## See Also

- [[index|worker/src/index.ts]] — routes `/oauth/*` to `handleOAuthRequest` and applies the bearer check
- [wire schemas](wire/oauth.md) — token request schemas
- [[schema]] — `oauthCodes`, `oauthClients`, `oauthTokens`
- [[mcp-tools]] — what callers reach after connecting
