import { CLIENT_HEADER, MIN_WRITE_PROTOCOL, UPGRADE_REQUIRED_STATUS, parseClientAnnouncement } from '@shared/wire/clientVersion';

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
