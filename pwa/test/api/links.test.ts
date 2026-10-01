import { expect, it } from 'vitest';
import { api } from '../../src/api/endpoints';
import { installFetchStub } from '../helpers/fetchStub';
import { parseLinkKey } from '@shared/wire/versions';
import { parseCommandEnvelope, parseChangesResult } from '@shared/wire/commands';
const config = { apiBase: 'http://localhost:8787', authToken: 'tok' };
const parsed = parseLinkKey({ entity: 'link', from: 't_first1', to: 't_second', linkType: 'blocks' });
if (!parsed.ok) throw new Error();
const key = parsed.value;
const row = { from_task_id: key.from, to_task_id: key.to, link_type: key.linkType };
const snapshot = { contractVersion: 2, key, row, structuralRevision: 4, version: { revision: 1, deletedAt: null } };
const id = JSON.stringify([key.from, key.to, key.linkType]);
const base = { contractVersion: 2, commandId: 'c_link001', payloadHash: 'a'.repeat(64), serverNow: '2026-10-01T10:00:00.123Z', warnings: [], refs: {}, applied: true };
it.each([
 snapshot, { ...snapshot, row: null, version: null },
 { ...snapshot, row: null, version: { revision: 2, deletedAt: base.serverNow } },
])('reads unknown/live/deleted links through the PWA boundary', async body => {
 const stub = installFetchStub(); stub.respondWith({ method: 'POST', path: '/api/v2/link' }, { type: 'json', status: 200, body });
 try { expect(await api.link(key, config)).toEqual({ kind: 'ok', value: body }); expect(stub.calls[0]?.body).toEqual(key); }
 finally { stub.restore(); }
});
it.each([
 { ...snapshot, version: null }, { ...snapshot, row: null }, { ...snapshot, version: { revision: 1, deletedAt: base.serverNow } },
 { ...snapshot, row: { ...row, to_task_id: 't_third1' } }, { ...snapshot, structuralRevision: -1 },
 { ...snapshot, version: { revision: Number.MAX_SAFE_INTEGER + 1, deletedAt: null } }, { ...snapshot, key: { ...key, from: 'bad' } },
])('rejects malformed or inconsistent link snapshots', async body => {
 const stub = installFetchStub(); stub.respondWith({ method: 'POST', path: '/api/v2/link' }, { type: 'json', status: 200, body });
 try { expect((await api.link(key, config)).kind).toBe('contract'); } finally { stub.restore(); }
});
it.each([
 { kind: 'link.add', expectedRevision: null, before: null, after: { row, revision: 1 } },
 { kind: 'link.remove', expectedRevision: 1, before: { row, revision: 1 }, after: { deleted: true, revision: 2 } },
 { kind: 'link.add', expectedRevision: 2, before: { row: null, revision: 2 }, after: { row, revision: 3 } },
])('parses $kind results including tombstone revival', async ({ kind, expectedRevision, before, after }) => {
 const input = parseCommandEnvelope({ contractVersion: 2, actor: 'user', commandId: base.commandId, commands: [{ kind, from: key.from, to: key.to, linkType: key.linkType, expectedRevision, expectedStructuralRevision: 4 }] });
 if (!input.ok) throw new Error(); const result = { ...base, changes: [{ entity: 'link', id, before, after }] };
 const stub = installFetchStub(); stub.respondWith({ method: 'POST', path: '/api/v2/changes' }, { type: 'json', status: 200, body: result });
 try { expect(await api.applyChanges(input.value, config)).toEqual({ kind: 'ok', value: result }); expect(stub.calls[0]?.body).toEqual(input.value); }
 finally { stub.restore(); }
});
it.each([
 { entity: 'link', id: 'bad', before: null, after: { row, revision: 1 } },
 { entity: 'link', id, before: { row, revision: 1 }, after: { deleted: true, revision: 3 } },
 { entity: 'link', id, before: null, after: { deleted: true, revision: 1 } },
 { entity: 'link', id, before: { row: null, revision: 2 }, after: { deleted: true, revision: 3 } },
 { entity: 'link', id, before: { row: { ...row, from_task_id: 't_third1' }, revision: 2 }, after: { row, revision: 3 } },
])('rejects inconsistent link diffs', change => { expect(parseChangesResult({ ...base, changes: [change] }).ok).toBe(false); });
it('retains parsed conflict snapshots without unsafe link client refs', async () => {
 const input = parseCommandEnvelope({ contractVersion: 2, actor: 'user', commandId: base.commandId, commands: [{ kind: 'link.add', from: key.from, to: key.to, linkType: key.linkType, expectedRevision: null, expectedStructuralRevision: 3 }] });
 if (!input.ok) throw new Error();
 const error = { code: 'revision_conflict', path: ['commands','0','expectedRevision'], message: 'Changed', retryable: false, recoveryHint: 'Retain intent', expectedRevision: null, currentLink: snapshot };
 const stub = installFetchStub(); stub.respondWith({ method: 'POST', path: '/api/v2/changes' }, { type: 'json', status: 409, body: { contractVersion: 2, error } });
 try { expect(await api.applyChanges(input.value, config)).toMatchObject({ kind: 'http', status: 409, body: { contractError: error } }); } finally { stub.restore(); }
 expect(parseChangesResult({ ...base, refs: { edge: key.from }, changes: [{ entity: 'link', id, before: null, after: { row, revision: 1 } }] }).ok).toBe(false);
});
