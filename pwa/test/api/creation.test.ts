import { expect, it } from 'vitest';
import { api } from '../../src/api/endpoints';
import { installFetchStub } from '../helpers/fetchStub';
import { parseCommandEnvelope } from '@shared/wire/commands';
import { parseEntityReadKey } from '@shared/wire/versions';

const config = { apiBase: 'http://localhost:8787', authToken: 'tok' };
const parsed = parseCommandEnvelope({ contractVersion: 2, commandId: 'c_create1', actor: 'user', commands: [{ kind: 'project.create', id: 'p_create1', clientRef: 'newProject', expectedRevision: null, expectedStructuralRevision: 0, values: { title: 'Created', notes: null, kickoffNote: null } }] });
const readKey = parseEntityReadKey({ entity: 'project', id: 'p_create1' });
if (!parsed.ok || !readKey.ok) throw new Error();
const input = parsed.value;
const key = readKey.value;
const row = { id: key.id, title: 'Created', notes: null, kickoff_note: null, status: 'active', created_at: '2026-10-01T10:00:00.123Z', updated_at: '2026-10-01T10:00:00.123Z' };
const result = { contractVersion: 2, commandId: input.commandId, payloadHash: 'a'.repeat(64), serverNow: row.created_at, applied: true,
  changes: [{ entity: 'project', id: key.id, before: null, after: { row, revision: 1 } }], refs: { newProject: key.id }, warnings: [],
};
const snapshot = { contractVersion: 2, ...key, row, structuralRevision: 1, version: { revision: 1, deletedAt: null } };
it('parses creation receipts and coherent content/version responses', async () => {
  const stub = installFetchStub();
  stub.respondWith({ method: 'POST', path: '/api/v2/changes' }, { type: 'json', status: 200, body: result });
  stub.respondWith({ method: 'POST', path: '/api/v2/entity' }, { type: 'json', status: 200, body: snapshot });
  try {
    expect(await api.applyChanges(input, config)).toEqual({ kind: 'ok', value: result });
    expect(await api.entity(key, config)).toEqual({ kind: 'ok', value: snapshot });
    expect(stub.calls.map(call => call.body)).toEqual([input, key]);
  } finally { stub.restore(); }
});
it.each([
  { ...snapshot, version: null }, { ...snapshot, version: { revision: 1, deletedAt: row.created_at } },
  { ...snapshot, row: null }, { ...snapshot, row: { ...row, id: 'p_another' } },
  { ...snapshot, structuralRevision: -1 }, { ...snapshot, row: { ...row, status: 'done' } },
])('rejects content/version inconsistencies', async body => {
  const stub = installFetchStub();
  stub.respondWith({ method: 'POST', path: '/api/v2/entity' }, { type: 'json', status: 200, body });
  try { expect((await api.entity(key, config)).kind).toBe('contract'); }
  finally { stub.restore(); }
});
it.each([
  { ...result, refs: { newProject: 'p_another' } },
  { ...result, changes: [{ ...result.changes[0], after: { row: { ...row, id: 'p_another' }, revision: 1 } }] },
  { ...result, changes: [{ ...result.changes[0], after: { row, revision: 2 } }] },
])('rejects mismatched creation IDs, ref maps and revisions', async body => {
  const stub = installFetchStub();
  stub.respondWith({ method: 'POST', path: '/api/v2/changes' }, { type: 'json', status: 200, body });
  try { expect((await api.applyChanges(input, config)).kind).toBe('contract'); }
  finally { stub.restore(); }
});
it('retains a parsed structural conflict with current content for future rebase', async () => {
  const detail = { code: 'structural_conflict', path: ['commands', '0'], message: 'Workspace changed', retryable: false,
    recoveryHint: 'Retain intent and rebase', expectedStructuralRevision: 0, currentEntity: snapshot,
  };
  const stub = installFetchStub();
  stub.respondWith({ method: 'POST', path: '/api/v2/changes' }, { type: 'json', status: 409, body: { contractVersion: 2, error: detail } });
  try { expect(await api.applyChanges(input, config)).toEqual({ kind: 'http', status: 409, body: { error: detail.message, contractError: detail } }); }
  finally { stub.restore(); }
});
it.each(['constructor', 'prototype', '__proto__'])('rejects reserved client reference %s', clientRef => {
  expect(parseCommandEnvelope({ ...input, commands: [{ ...input.commands[0], clientRef }] }).ok).toBe(false);
});
