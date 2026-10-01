import { expect, it } from 'vitest';
import { api } from '../../src/api/endpoints';
import { installFetchStub } from '../helpers/fetchStub';
import { parseCommandEnvelope } from '@shared/wire/commands';
const config = { apiBase: 'http://localhost:8787', authToken: 'tok' };
const parsed = parseCommandEnvelope({ contractVersion: 2, commandId: 'c_content1', actor: 'user', commands: [{ kind: 'project.content.set', id: 'p_first1', expectedRevision: 1, values: { title: 'Edited', notes: null, kickoffNote: null } }] });
if (!parsed.ok) throw new Error();
const input = parsed.value;
const row = { id: 'p_first1', title: 'Original', notes: 'Notes', kickoff_note: null, status: 'active', created_at: '2026-10-01T10:00:00.123Z', updated_at: '2026-10-01T10:00:00.123Z' };
const change = { entity: 'project', id: row.id, before: { row, revision: 1 }, after: { row: { ...row, title: 'Edited', notes: null }, revision: 2 } };
const result = { contractVersion: 2, commandId: input.commandId, payloadHash: 'a'.repeat(64), serverNow: row.created_at, changes: [change], refs: {}, warnings: [], applied: true };
it('parses versioned content diffs and sends expected revision unchanged', async () => {
  const stub = installFetchStub();
  stub.respondWith({ method: 'POST', path: '/api/v2/changes' }, { type: 'json', status: 200, body: result });
  try { expect(await api.applyChanges(input, config)).toEqual({ kind: 'ok', value: result }); expect(stub.calls[0]?.body).toEqual(input); }
  finally { stub.restore(); }
});
it.each([
  { ...result, changes: [{ ...change, before: { ...change.before, row: { ...row, id: 'p_other1' } } }] },
  { ...result, changes: [{ ...change, after: { ...change.after, revision: 3 } }] },
  { ...result, refs: { content: row.id } }, { ...result, refs: { constructor: row.id } },
  { ...result, changes: [] },
])('rejects inconsistent content versions/IDs and reference maps', async body => {
  const stub = installFetchStub();
  stub.respondWith({ method: 'POST', path: '/api/v2/changes' }, { type: 'json', status: 200, body });
  try { expect((await api.applyChanges(input, config)).kind).toBe('contract'); }
  finally { stub.restore(); }
});
