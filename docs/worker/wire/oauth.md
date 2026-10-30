# worker/src/wire/oauth.ts

OAuth wire schemas.

## Types And Schemas

Defines branded types and schemas for redirect URIs, client IDs, state, code challenge, code verifier and code challenge method.

`OAuthTokenBodySchema` is a variant on `grant_type`: `AuthorizationCodeGrantSchema` (code, optional verifier, redirect URI) or `RefreshTokenGrantSchema`. Both accept optional `client_id` / `client_secret`, because clients may authenticate with an HTTP Basic header instead. [[oauth|worker/src/oauth.ts]] parses every `/oauth/token` body with it.
