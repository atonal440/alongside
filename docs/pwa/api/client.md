# pwa/src/api/client.ts

Minimal HTTP client for talking to the Cloudflare Worker REST API.

## Types

**`ApiConfig`** — `{ apiBase: string; authToken: string }`. Holds the worker URL and bearer token, read from `localStorage` keys `alongside_api` and `alongside_token`.

## Functions

**`apiFetch(config, method, path, body?)`** — Makes an authenticated `fetch` call to `config.apiBase + path` with the `Authorization: Bearer` header set. Returns the parsed JSON response, or `null` if the request fails or returns a non-2xx status. All sync and action modules use this as their sole HTTP primitive.
