// HMAC-based URL signing for iframe widget auth.
// Signs a scope ("ui") + timestamp using AUTH_TOKEN. One signature
// grants access to all /ui/* routes. No expiry by default, but the
// timestamp is included so expiry can be added later.

const encoder = new TextEncoder();

async function hmac(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return [...new Uint8Array(sig)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Generate a signed URL for the iframe widget. */
export async function signUrl(baseUrl: string, path: string, secret: string): Promise<string> {
  const t = Math.floor(Date.now() / 1000).toString();
  const sig = await hmac(secret, `ui:${t}`);
  const sep = path.includes('?') ? '&' : '?';
  return `${baseUrl}${path}${sep}t=${t}&sig=${sig}`;
}

/** Verify a signed request to any /ui/* route. Returns true if valid. */
export async function verifySignature(
  _path: string,
  searchParams: URLSearchParams,
  secret: string,
  maxAgeSec?: number
): Promise<boolean> {
  const t = searchParams.get('t');
  const sig = searchParams.get('sig');
  if (!t || !sig) return false;

  // Optional expiry check
  if (maxAgeSec !== undefined) {
    const age = Math.floor(Date.now() / 1000) - parseInt(t, 10);
    if (age < 0 || age > maxAgeSec) return false;
  }

  const expected = await hmac(secret, `ui:${t}`);
  return sig === expected;
}
