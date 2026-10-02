import { describe, expect, it } from 'vitest';
import { checkClientGate } from '../src/clientGate';
import { MIN_WRITE_PROTOCOL, parseClientAnnouncement } from '@shared/wire/clientVersion';

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
