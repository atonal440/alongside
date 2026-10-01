import { expect, it } from 'vitest';
import { api } from '../../src/api/endpoints';
import { parseCommandEnvelope } from '@shared/wire/commands';
import { installFetchStub } from '../helpers/fetchStub';
const config = { apiBase: 'http://localhost:8787', authToken: 'tok' };
const project = { id: 'p_first1', title: 'Project', notes: null, kickoff_note: null, status: 'active', created_at: '2026-10-01T10:00:00.123Z', updated_at: '2026-10-01T10:00:00.123Z' };
const task = { ...project, id: 't_first1', status: 'pending', task_type: 'action', project_id: null, due_date: null, due_all_day: null, recurrence: null, defer_kind: 'none', defer_until: null, focused_until: null, session_log: null, duty_id: null, occurrence_at: null };
const cases = [
  { kind: 'task.focus.set', fields: { focusedUntil: '2026-10-02T03:22:59+02:00' }, before: task, after: { ...task, focused_until: '2026-10-02T01:22:00Z' } },
  { kind: 'task.defer.set', fields: { defer: { kind: 'someday' } }, before: task, after: { ...task, defer_kind: 'someday' } },
  { kind: 'task.reopen', fields: {}, before: { ...task, status: 'done' }, after: task },
  { kind: 'project.archive', fields: {}, before: project, after: { ...project, status: 'archived' } },
  { kind: 'project.reopen', fields: {}, before: { ...project, status: 'archived' }, after: project },
];
it.each(cases)('parses $kind input/results at client boundary', async ({ kind, fields, before, after }) => {
  const parsed = parseCommandEnvelope({ contractVersion: 2, commandId: 'c_state01', actor: 'user', commands: [{ kind, id: before.id, expectedRevision: 1, ...fields }] });
  if (!parsed.ok) throw new Error();
  const result = { contractVersion: 2, commandId: parsed.value.commandId, payloadHash: 'a'.repeat(64), serverNow: project.created_at, changes: [{ entity: kind.startsWith('task.') ? 'task' : 'project', id: before.id, before: { row: before, revision: 1 }, after: { row: after, revision: 2 } }], refs: {}, warnings: [], applied: true };
  const stub = installFetchStub(); stub.respondWith({ method: 'POST', path: '/api/v2/changes' }, { type: 'json', status: 200, body: result });
  try {
    expect(await api.applyChanges(parsed.value, config)).toEqual({ kind: 'ok', value: result });
    expect(stub.calls[0]?.body).toEqual(parsed.value);
    if (kind === 'task.focus.set') expect(stub.calls[0]?.body).toMatchObject({ commands: [{ focusedUntil: '2026-10-02T01:22:00Z' }] });
  } finally { stub.restore(); }
});
it('retains invalid-transition details and parsed current row/version for future rebase', async () => {
  const parsed = parseCommandEnvelope({ contractVersion: 2, commandId: 'c_state01', actor: 'user', commands: [{ kind: 'project.reopen', id: project.id, expectedRevision: 1 }] });
  if (!parsed.ok) throw new Error();
  const currentEntity = { contractVersion: 2, entity: 'project', id: project.id, row: project, version: { revision: 1, deletedAt: null }, structuralRevision: 5 };
  const error = { code: 'invalid_transition', path: ['commands', '0'], message: 'Only archived projects can be reopened.', retryable: false, recoveryHint: 'Keep intent.', currentEntity };
  const stub = installFetchStub(); stub.respondWith({ method: 'POST', path: '/api/v2/changes' }, { type: 'json', status: 409, body: { contractVersion: 2, error } });
  try { expect(await api.applyChanges(parsed.value, config)).toMatchObject({ kind: 'http', status: 409, body: { contractError: error } }); }
  finally { stub.restore(); }
});

it.each(['0001-01-01T00:00:00Z', '0099-12-31T23:59:00Z', '0100-01-01T00:00:00+01:00'])('rejects unsupported normalized task scheduling years: %s', instant => {
  expect(parseCommandEnvelope({ contractVersion: 2, commandId: 'c_state01', actor: 'user', commands: [{ kind: 'task.focus.set', id: task.id, expectedRevision: 1, focusedUntil: instant }] }).ok).toBe(false);
  expect(parseCommandEnvelope({ contractVersion: 2, commandId: 'c_state01', actor: 'user', commands: [{ kind: 'task.defer.set', id: task.id, expectedRevision: 1, defer: { kind: 'until', until: instant } }] }).ok).toBe(false);
});
