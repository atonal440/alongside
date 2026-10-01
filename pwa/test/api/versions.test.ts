import { describe, expect, it } from 'vitest';
import { api } from '../../src/api/endpoints';
import { installFetchStub } from '../helpers/fetchStub';
import { parseEntityKey, parseEntityVersionResponse } from '@shared/wire/versions';

const config = { apiBase: 'http://localhost:8787', authToken: 'tok' };
const parsed = parseEntityKey({ entity: 'task', id: 't_first1' });
if (!parsed.ok) throw new Error();
const key = parsed.value;
const response = { contractVersion: 2, key, structuralRevision: 12, version: { revision: 3, deletedAt: null } };

describe('PWA version lookup boundary', () => {
  it.each([null, response.version, { revision: 4, deletedAt: '2026-10-01T10:00:00.123Z' }])('parses absent/live/tombstone records and submits the branded key', async version => {
    const stub = installFetchStub();
    stub.respondWith({ method: 'POST', path: '/api/v2/entity-version' }, { type: 'json', status: 200, body: { ...response, version } });
    try {
      expect(await api.entityVersion(key, config)).toEqual({ kind: 'ok', value: { ...response, version } });
      expect(stub.calls[0]?.body).toEqual(key);
    } finally { stub.restore(); }
  });
  it.each([
    { ...response, extra: true }, { ...response, structuralRevision: -1 }, { ...response, structuralRevision: Number.MAX_SAFE_INTEGER + 1 },
    { ...response, version: { revision: 1.5, deletedAt: null } }, { ...response, version: { revision: 1, deletedAt: 'bad' } },
    { ...response, version: { revision: 1 } }, { ...response, key: { entity: 'task', id: 'bad' } },
  ])('rejects malformed server versions', async body => {
    const stub = installFetchStub();
    stub.respondWith({ method: 'POST', path: '/api/v2/entity-version' }, { type: 'json', status: 200, body });
    try { expect((await api.entityVersion(key, config)).kind).toBe('contract'); }
    finally { stub.restore(); }
  });
  it('parses every discriminated identity without accepting unknown mutation fields', () => {
    for (const input of [
      { entity: 'project', id: 'p_first1' }, { entity: 'duty', id: 'd_first1' },
      { entity: 'link', from: 't_first1', to: 't_other1', linkType: 'blocks' },
    ]) {
      const result = parseEntityKey(input);
      expect(result.ok).toBe(true);
      expect(parseEntityVersionResponse({ ...response, key: input }).ok).toBe(true);
      expect(parseEntityKey({ ...input, revision: 1 }).ok).toBe(false);
    }
  });
});
