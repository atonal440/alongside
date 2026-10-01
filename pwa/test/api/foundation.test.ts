import { describe, expect, it } from 'vitest';
import { api } from '../../src/api/endpoints';
import { installFetchStub } from '../helpers/fetchStub';
import { parseSchema } from '@shared/parse';
import { ResolveTimeInputSchema } from '@shared/wire/planning';
const config = { apiBase: 'http://localhost:8787', authToken: 'tok' };

describe('PWA temporal response boundary', () => {
  it('parses branded normalized time results from the v2 endpoint', async () => {
    const stub = installFetchStub();
    const input = parseSchema(ResolveTimeInputSchema, { kind: 'wall_time', date: '2026-09-30', time: '09:00' });
    if (!input.ok) throw new Error();
    stub.respondWith({ method: 'POST', path: '/api/v2/resolve-time' }, { type: 'json', status: 200, body: {
      contractVersion: 2, serverNow: '2026-09-30T23:00:00.123Z', timezone: 'UTC', timezoneSource: 'fallback_utc', at: '2026-09-30T09:00:00Z', comparison: 'inclusive',
    } });
    try {
      const result = await api.resolveTime(input.value, config);
      expect(result.kind).toBe('ok');
      if (result.kind === 'ok') expect(result.value.at).toBe('2026-09-30T09:00:00Z');
      expect(stub.calls[0]?.body).toEqual(input.value);
    } finally { stub.restore(); }
  });
  it('rejects malformed capability and preview responses', async () => {
    const stub = installFetchStub();
    stub.respondWith({ method: 'GET', path: '/api/v2/capabilities' }, { type: 'json', status: 200, body: { contractVersion: 2, timezone: 'UTC' } });
    stub.respondWith({ method: 'POST', path: '/api/v2/legacy-dates/preview' }, { type: 'json', status: 200, body: { candidates: [] } });
    try {
      expect((await api.capabilities(config)).kind).toBe('contract');
      expect((await api.previewLegacyDates({}, config)).kind).toBe('contract');
    } finally { stub.restore(); }
  });
});

describe('PWA v2 structured error boundary', () => {
  it('preserves fold alternatives, codes and recovery hints', async () => {
    const stub = installFetchStub();
    const input = parseSchema(ResolveTimeInputSchema, { kind: 'wall_time', date: '2026-11-01', time: '01:30', timezone: 'America/Los_Angeles' });
    if (!input.ok) throw new Error();
    const detail = {
      code: 'ambiguous_local_time', path: ['time'], message: 'This local time occurs twice.', retryable: false, recoveryHint: 'Specify earlier or later.',
      alternatives: [{ at: '2026-11-01T08:30:00Z', date: '2026-11-01', time: '01:30' }, { at: '2026-11-01T09:30:00Z', date: '2026-11-01', time: '01:30' }],
    };
    stub.respondWith({ method: 'POST', path: '/api/v2/resolve-time' }, { type: 'json', status: 400, body: { contractVersion: 2, error: detail } });
    try {
      const result = await api.resolveTime(input.value, config);
      expect(result).toEqual({ kind: 'http', status: 400, body: { error: detail.message, contractError: detail } });
    } finally { stub.restore(); }
  });
  it('validates structured errors while preserving legacy authentication failures', async () => {
    const stub = installFetchStub();
    stub.respondWith({ method: 'GET', path: '/api/v2/capabilities' }, { type: 'json', status: 400, body: { contractVersion: 2, error: { code: 5, message: 'Invalid' } } });
    try {
      expect((await api.capabilities(config)).kind).toBe('contract');
    } finally { stub.restore(); }
    const auth = installFetchStub();
    auth.respondWith({ method: 'GET', path: '/api/v2/capabilities' }, { type: 'json', status: 401, body: { error: 'Unauthorized' } });
    try {
      expect(await api.capabilities(config)).toEqual({ kind: 'http', status: 401, body: { error: 'Unauthorized' } });
    } finally { auth.restore(); }
  });
});
