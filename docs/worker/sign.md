# worker/src/sign.ts

URL signing utilities for the `/ui/*` iframe widget routes. Because the widget is embedded without a bearer token, requests are authenticated by an HMAC-SHA256 signature in the URL instead.

## Functions

**`signUrl(url, secret, expiresIn?)`** — Takes a base URL and a secret key, appends an expiry timestamp, and appends an `sig` query parameter containing the HMAC-SHA256 signature of the full URL. Returns the signed URL string.

**`verifySignature(url, secret)`** — Strips the `sig` parameter from the URL, recomputes the expected HMAC, and compares it to the provided signature using a constant-time comparison. Also checks that the `expires` timestamp has not passed. Returns `true` if valid.
