/**
 * Client protocol negotiation. A browser client announces itself on every request with
 * `X-Alongside-Client: <name>/<protocol>`. The server refuses *writes* from a browser that
 * announces nothing or an older protocol, because such a client predates the canonical
 * command/sync contract and could overwrite fields it does not understand.
 */
export const CLIENT_HEADER = 'X-Alongside-Client';
/** The protocol this build of the PWA speaks. */
/** 3 = parses command-kind action-log names (see docs/plans/mcp-surface.md). */
export const CLIENT_PROTOCOL = 3;
/** Oldest browser-client protocol still allowed to write. Raise it to lock out old builds. */
export const MIN_WRITE_PROTOCOL = 2;
/**
 * Oldest browser-client protocol allowed to read the sync feed (snapshot and delta). Protocol 3
 * parses command-kind action-log names; older builds would reject a feed page that contains one
 * and fail every pull, so they are told to reload before the worker writes such a row.
 */
export const MIN_SYNC_READ_PROTOCOL = 3;
export const UPGRADE_REQUIRED_STATUS = 426;

export interface ClientAnnouncement { name: string; protocol: number }

export function parseClientAnnouncement(value: string | null): ClientAnnouncement | null {
  const match = /^([a-z][a-z0-9-]{0,31})\/([0-9]{1,6})$/.exec(value ?? '');
  return match ? { name: match[1]!, protocol: Number(match[2]) } : null;
}

export const formatClientAnnouncement = (name: string, protocol: number): string => `${name}/${protocol}`;
