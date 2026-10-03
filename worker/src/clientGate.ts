import { CLIENT_HEADER, MIN_SYNC_READ_PROTOCOL, MIN_WRITE_PROTOCOL, UPGRADE_REQUIRED_STATUS, parseClientAnnouncement } from '@shared/wire/clientVersion';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Block writes from browser clients too old to speak the current protocol. Browsers always send
 * `Origin` on cross-origin writes, so a write that carries `Origin` but no sufficient
 * `X-Alongside-Client` is an older PWA build; scripts and tools (no `Origin`) are not gated, and
 * reads are never gated so an old tab can still show its data and be told to update.
 */
export function checkClientGate(request: Request): Response | null {
  if (READ_METHODS.has(request.method) || request.headers.get('Origin') === null) return null;
  const client = parseClientAnnouncement(request.headers.get(CLIENT_HEADER));
  if (client !== null && client.protocol >= MIN_WRITE_PROTOCOL) return null;
  return new Response(JSON.stringify({
    error: 'upgrade_required',
    message: 'This version of Alongside is out of date. Reload the app to update before making changes.',
    minimumProtocol: MIN_WRITE_PROTOCOL,
    clientProtocol: client?.protocol ?? null,
  }), { status: UPGRADE_REQUIRED_STATUS, headers: { 'Content-Type': 'application/json' } });
}

const SYNC_READ_PATHS = new Set(['/api/v2/sync/snapshot', '/api/v2/sync/delta']);

/**
 * Refuse the sync feed to a browser client that cannot parse what it may now contain. Unlike the
 * write gate this keys on the announced protocol, whether or not the request carries `Origin`
 * (browsers omit it on same-origin GETs, so an Origin check alone would let an old tab through).
 * A client that announces nothing is treated as an old browser build only when it sends `Origin`;
 * scripts and tools that announce nothing and send no `Origin` are not gated, and neither are
 * clients announcing some other name. A pwa/2 tab already treats any 426 as "reload to update"
 * and keeps its queued work.
 */
export function checkSyncReadGate(request: Request, url: URL): Response | null {
  if (!SYNC_READ_PATHS.has(url.pathname) || request.method === 'OPTIONS') return null;
  const client = parseClientAnnouncement(request.headers.get(CLIENT_HEADER));
  if (client !== null ? client.name !== 'pwa' || client.protocol >= MIN_SYNC_READ_PROTOCOL : request.headers.get('Origin') === null) return null;
  return new Response(JSON.stringify({
    error: 'upgrade_required',
    message: 'This version of Alongside is out of date. Reload the app to update before syncing.',
    minimumProtocol: MIN_SYNC_READ_PROTOCOL,
    clientProtocol: client?.protocol ?? null,
  }), { status: UPGRADE_REQUIRED_STATUS, headers: { 'Content-Type': 'application/json' } });
}
