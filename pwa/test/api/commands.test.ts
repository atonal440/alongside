import { describe, expect, it } from 'vitest';
import { api } from '../../src/api/endpoints';
import { installFetchStub } from '../helpers/fetchStub';
import { parseCommandEnvelope } from '@shared/wire/commands';

const config = { apiBase: 'http://localhost:8787', authToken: 'tok' };
const settings = { timezone: 'UTC', bufferMinutes: 15, workingHours: [{ weekday: 1, start: '09:00', end: '17:00' }], revision: 1 };
const parsed = parseCommandEnvelope({ contractVersion: 2, commandId: 'c_first1', actor: 'user', commands: [{ kind: 'planning.set', expectedRevision: null, values: { timezone: settings.timezone, bufferMinutes: settings.bufferMinutes, workingHours: settings.workingHours } }] });
if (!parsed.ok) throw new Error();
const input = parsed.value;
const result = { contractVersion: 2, commandId: input.commandId, payloadHash: 'a'.repeat(64), serverNow: '2026-10-01T01:00:00.123Z',
  applied: true, changes: [{ entity: 'planning_settings', id: 'workspace', before: null, after: settings }], warnings: [], refs: {},
};
describe('PWA reliable command response boundaries', () => {
  it('parses settings/export/preview/apply and submits branded command identity unchanged', async () => {
    const stub = installFetchStub();
    const { revision: _revision, ...values } = settings;
    const { applied: _applied, ...preview } = result;
    stub.respondWith({ method: 'GET', path: '/api/v2/planning-settings' }, { type: 'json', status: 200, body: { contractVersion: 2, settings } });
    stub.respondWith({ method: 'GET', path: '/api/v2/planning-settings/export' }, { type: 'json', status: 200, body: { contractVersion: 2, kind: 'planning_settings', exportedAt: result.serverNow, values } });
    stub.respondWith({ method: 'POST', path: '/api/v2/changes/preview' }, { type: 'json', status: 200, body: { ...preview, dryRun: true, requiredStatements: 7 } });
    stub.respondWith({ method: 'POST', path: '/api/v2/changes' }, { type: 'json', status: 200, body: result });
    try {
      expect((await api.planningSettings(config)).kind).toBe('ok');
      expect((await api.exportPlanningSettings(config)).kind).toBe('ok');
      expect((await api.previewChanges(input, config)).kind).toBe('ok');
      expect(await api.applyChanges(input, config)).toEqual({ kind: 'ok', value: result });
      expect(stub.calls.filter(call => call.method === 'POST').map(call => call.body)).toEqual([input, input]);
    } finally { stub.restore(); }
  });
  it.each([
    { ...result, payloadHash: 'invalid' }, { ...result, commandId: 'invalid' }, { ...result, extra: true },
    { ...result, changes: [{ ...result.changes[0], after: { ...settings, revision: -1 } }] },
    { ...result, changes: [{ ...result.changes[0], after: { ...settings, workingHours: [{ weekday: 1, start: 'bad', end: '17:00' }] } }] },
  ])('rejects malformed command result data', async body => {
    const stub = installFetchStub();
    stub.respondWith({ method: 'POST', path: '/api/v2/changes' }, { type: 'json', status: 200, body });
    try { expect((await api.applyChanges(input, config)).kind).toBe('contract'); }
    finally { stub.restore(); }
  });
  it('retains a parsed revision conflict and its current values for a future rebase UI', async () => {
    const stub = installFetchStub();
    const detail = { code: 'revision_conflict', path: ['commands', '0', 'expectedRevision'], message: 'Settings changed.', retryable: false,
      recoveryHint: 'Retain intent and rebase.', currentSettings: settings, expectedRevision: null,
    };
    stub.respondWith({ method: 'POST', path: '/api/v2/changes' }, { type: 'json', status: 409, body: { contractVersion: 2, error: detail } });
    try { expect(await api.applyChanges(input, config)).toEqual({ kind: 'http', status: 409, body: { error: detail.message, contractError: detail } }); }
    finally { stub.restore(); }
  });
  it('rejects unparsed nested current settings in conflict errors', async () => {
    const stub = installFetchStub();
    stub.respondWith({ method: 'POST', path: '/api/v2/changes' }, { type: 'json', status: 409, body: { contractVersion: 2, error: { code: 'revision_conflict', path: [], message: 'Changed', retryable: false, recoveryHint: 'Rebase', currentSettings: { ...settings, timezone: 'Bogus/Zone' } } } });
    try { expect((await api.applyChanges(input, config)).kind).toBe('contract'); }
    finally { stub.restore(); }
  });
});
