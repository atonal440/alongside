import { describe, expect, it } from 'vitest';
import { checkClientGate, checkSyncReadGate } from '../src/clientGate';
import { MIN_SYNC_READ_PROTOCOL, MIN_WRITE_PROTOCOL, parseClientAnnouncement } from '@shared/wire/clientVersion';

const req = (method: string, headers: Record<string, string> = {}) => new Request('https://alongside.test/api/tasks', { method, headers });

describe('client protocol gate', () => {
  it('parses announcements strictly', () => {
    expect(parseClientAnnouncement('pwa/2')).toEqual({ name: 'pwa', protocol: 2 });
    for (const bad of [null, '', 'pwa', 'pwa/', 'pwa/x', '/2', 'PWA/2', 'pwa/2/3', 'pwa/1234567']) expect(parseClientAnnouncement(bad)).toBeNull();
  });

  it('never gates reads or tools without an Origin', async () => {
    expect(checkClientGate(req('GET', { Origin: 'https://app.test' }))).toBeNull();
    expect(checkClientGate(req('OPTIONS', { Origin: 'https://app.test' }))).toBeNull();
    expect(checkClientGate(req('POST'))).toBeNull();
    expect(checkClientGate(req('DELETE'))).toBeNull();
  });

  it('refuses browser writes that announce nothing (an older PWA build) with 426', async () => {
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
      const res = checkClientGate(req(method, { Origin: 'https://app.test' }));
      expect(res?.status).toBe(426);
      expect(await res?.json()).toMatchObject({ error: 'upgrade_required', minimumProtocol: MIN_WRITE_PROTOCOL, clientProtocol: null });
    }
  });

  it('refuses an announced protocol below the minimum and reports it', async () => {
    const res = checkClientGate(req('POST', { Origin: 'https://app.test', 'X-Alongside-Client': `pwa/${MIN_WRITE_PROTOCOL - 1}` }));
    expect(res?.status).toBe(426);
    expect(await res?.json()).toMatchObject({ clientProtocol: MIN_WRITE_PROTOCOL - 1 });
  });

  it('treats a malformed announcement as announcing nothing', () => {
    expect(checkClientGate(req('POST', { Origin: 'https://app.test', 'X-Alongside-Client': 'garbage' }))?.status).toBe(426);
  });

  it('lets a current or newer browser client write', () => {
    expect(checkClientGate(req('POST', { Origin: 'https://app.test', 'X-Alongside-Client': `pwa/${MIN_WRITE_PROTOCOL}` }))).toBeNull();
    expect(checkClientGate(req('PATCH', { Origin: 'https://app.test', 'X-Alongside-Client': `pwa/${MIN_WRITE_PROTOCOL + 5}` }))).toBeNull();
  });
});

describe('sync read gate', () => {
  const sync = (path: string, method: string, headers: Record<string, string> = {}) => ({ request: new Request(`https://alongside.test${path}`, { method, headers }), url: new URL(`https://alongside.test${path}`) });
  const gate = (path: string, method: string, headers?: Record<string, string>) => { const { request, url } = sync(path, method, headers); return checkSyncReadGate(request, url); };

  it('refuses a pwa client below protocol 3 on snapshot and delta, with or without Origin', async () => {
    for (const [path, method] of [['/api/v2/sync/snapshot', 'GET'], ['/api/v2/sync/delta', 'POST']] as const) {
      for (const origin of [{}, { Origin: 'https://app.test' }]) {
        const res = gate(path, method, { 'X-Alongside-Client': 'pwa/2', ...origin });
        expect(res?.status, `${path} ${JSON.stringify(origin)}`).toBe(426);
        expect(await res?.json()).toMatchObject({ error: 'upgrade_required', minimumProtocol: MIN_SYNC_READ_PROTOCOL, clientProtocol: 2 });
      }
    }
    expect(gate('/api/v2/sync/snapshot', 'GET', { 'X-Alongside-Client': 'pwa/1' })?.status).toBe(426);
  });

  it('refuses a browser build that announces nothing, but not a script that announces nothing', async () => {
    expect(gate('/api/v2/sync/snapshot', 'GET', { Origin: 'https://app.test' })?.status).toBe(426);
    expect(gate('/api/v2/sync/snapshot', 'GET', { Origin: 'https://app.test', 'X-Alongside-Client': 'garbage' })?.status).toBe(426);
    expect(gate('/api/v2/sync/snapshot', 'GET')).toBeNull();
    expect(gate('/api/v2/sync/delta', 'POST')).toBeNull();
  });

  it('lets current clients, other client names and every other route through', () => {
    expect(gate('/api/v2/sync/snapshot', 'GET', { 'X-Alongside-Client': `pwa/${MIN_SYNC_READ_PROTOCOL}`, Origin: 'https://app.test' })).toBeNull();
    expect(gate('/api/v2/sync/delta', 'POST', { 'X-Alongside-Client': `pwa/${MIN_SYNC_READ_PROTOCOL + 4}` })).toBeNull();
    expect(gate('/api/v2/sync/snapshot', 'GET', { 'X-Alongside-Client': 'cli/1' })).toBeNull();
    expect(gate('/api/tasks', 'GET', { 'X-Alongside-Client': 'pwa/2', Origin: 'https://app.test' })).toBeNull();
    expect(gate('/api/v2/entity', 'POST', { 'X-Alongside-Client': 'pwa/2' })).toBeNull();
    expect(gate('/api/v2/sync/snapshot', 'OPTIONS', { 'X-Alongside-Client': 'pwa/2' })).toBeNull();
  });

  it('is enforced by the worker entrypoint before the feed is read', async () => {
    const { default: worker } = await import('../src/index');
    const { sqliteD1 } = await import('./helpers/sqliteD1');
    const { sql, d1 } = sqliteD1();
    try {
      const env = { DB: d1, AUTH_TOKEN: 'tok' };
      const fetchAs = (path: string, method: string, headers: Record<string, string>) =>
        worker.fetch(new Request(`https://alongside.test${path}`, { method, headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json', ...headers }, ...(method === 'POST' ? { body: JSON.stringify({ cursor: { epoch: 0, sequence: 0 } }) } : {}) }), env);
      const old = await fetchAs('/api/v2/sync/snapshot', 'GET', { 'X-Alongside-Client': 'pwa/2' });
      expect(old.status).toBe(426);
      expect(old.headers.get('Access-Control-Allow-Origin')).toBe('*');           // the old tab can read the 426
      expect((await fetchAs('/api/v2/sync/delta', 'POST', { 'X-Alongside-Client': 'pwa/2' })).status).toBe(426);
      expect((await fetchAs('/api/v2/sync/snapshot', 'GET', { 'X-Alongside-Client': 'pwa/4', Origin: 'https://app.test' })).status).toBe(200);
      expect((await fetchAs('/api/v2/sync/snapshot', 'GET', { 'X-Alongside-Client': 'pwa/3', Origin: 'https://app.test' })).status).toBe(426);
      expect((await fetchAs('/api/v2/sync/snapshot', 'GET', {})).status).toBe(200);
      expect((await fetchAs('/api/tasks', 'GET', { 'X-Alongside-Client': 'pwa/2', Origin: 'https://app.test' })).status).toBe(200);
    } finally { sql.close(); }
  });
});
