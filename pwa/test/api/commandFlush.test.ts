import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { resetIdb } from '../helpers/idb';
import { closeDb } from '../../src/idb/db';
import { installFetchStub, type FetchStub } from '../helpers/fetchStub';
import { config, taskRow } from '../helpers/syncFixtures';
import { flushPendingOps, _resetStuckNotice } from '../../src/api/sync';
import { idbGetPendingOps, idbQueueOp } from '../../src/idb/pendingOps';
import { idbGetRetainedOps } from '../../src/idb/retainedOps';
import type { Intent } from '../../src/sync/intent';

let stub: FetchStub;
beforeEach(async () => { closeDb(); await resetIdb(); _resetStuckNotice(); stub = installFetchStub(); });
afterEach(() => stub.restore());

const queue = (intent: Intent, base: number | null, commandId = 'c_cmd0001') => idbQueueOp({ op: 'command', commandId, intent, base });
const entityBody = (id: string, revision: number | null, extra: Record<string, unknown> = {}, structuralRevision = 7) => ({
  contractVersion: 2, entity: 'task', id, structuralRevision,
  row: revision === null ? null : taskRow(id, extra), version: revision === null ? null : { revision, deletedAt: null },
});
const entity = (body: unknown) => stub.respondWith({ method: 'POST', path: '/api/v2/entity' }, { type: 'json', status: 200, body });
const changes = (status: number, body: unknown) => stub.respondWith({ method: 'POST', path: '/api/v2/changes' }, { type: 'json', status, body });
const applied = (commandId: string, id: string, before: number, extra: Record<string, unknown>) => ({
  contractVersion: 2, commandId, payloadHash: 'a'.repeat(64), serverNow: '2026-10-02T10:00:00.123Z', applied: true, warnings: [], refs: {},
  changes: [{ entity: 'task', id, before: { revision: before, row: taskRow(id) }, after: { revision: before + 1, row: taskRow(id, extra) } }],
});
const error = (code: string, extra: Record<string, unknown> = {}) => ({ contractVersion: 2, error: { code, path: ['commands', '0'], message: code, retryable: false, recoveryHint: 'x', ...extra } });
const bodies = (path: string) => stub.calls.filter(c => c.path.endsWith(path)).map(c => c.body as Record<string, any>);

describe('flushing reliable commands', () => {
  it('builds the envelope from the server row and revision, sends it, and drops the op on success', async () => {
    await queue({ kind: 'task.content', id: 't_abc001', title: 'Mine' }, 3);
    entity(entityBody('t_abc001', 3, { title: 'Server', notes: 'keep me' }));
    changes(200, applied('c_cmd0001', 't_abc001', 3, { title: 'Mine' }));
    expect(await flushPendingOps(config)).toMatchObject({ flushed: 1, rejected: [], halted: false });
    expect(await idbGetPendingOps()).toEqual([]);
    expect(bodies('/api/v2/changes')[0]).toMatchObject({ commandId: 'c_cmd0001', commands: [{ kind: 'task.content.set', id: 't_abc001', expectedRevision: 3, values: { title: 'Mine', notes: 'keep me' } }] });
  });

  it('a lost response is retried with the identical stored payload and command ID, without re-reading the server', async () => {
    await queue({ kind: 'task.focus', id: 't_abc001', focusedUntil: '2026-10-05T12:00:00Z' }, 3);
    entity(entityBody('t_abc001', 3));
    stub.networkError({ method: 'POST', path: '/api/v2/changes' });
    expect(await flushPendingOps(config)).toMatchObject({ flushed: 0, halted: true });
    const [kept] = await idbGetPendingOps();
    expect(kept).toMatchObject({ attempts: 1, sent: { commandId: 'c_cmd0001' } });
    changes(200, applied('c_cmd0001', 't_abc001', 3, { focused_until: '2026-10-05T12:00:00Z' }));
    expect(await flushPendingOps(config)).toMatchObject({ flushed: 1 });
    const sent = bodies('/api/v2/changes');
    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(bodies('/api/v2/entity')).toHaveLength(1);
  });

  it('a revision conflict retains the intent with the current revision and does not retry it', async () => {
    await queue({ kind: 'task.content', id: 't_abc001', title: 'Mine' }, 3);
    entity(entityBody('t_abc001', 5));
    changes(409, error('revision_conflict', { currentEntity: entityBody('t_abc001', 5, { title: 'Theirs' }) }));
    const summary = await flushPendingOps(config);
    expect(summary).toMatchObject({ flushed: 0, halted: false });
    expect(summary.rejected).toHaveLength(1);
    expect(await idbGetPendingOps()).toEqual([]);
    expect(await idbGetRetainedOps()).toMatchObject([{ reason: { kind: 'conflict', status: 409, currentRevision: 5 }, op: { op: 'command', intent: { kind: 'task.content', title: 'Mine' } } }]);
  });

  it('a structural conflict proves nothing applied: rebuild against the new aggregate revision once', async () => {
    await queue({ kind: 'task.delete', id: 't_abc001' }, 3);
    entity(entityBody('t_abc001', 3, {}, 7));
    changes(409, error('structural_conflict', { expectedStructuralRevision: 7 }));
    entity(entityBody('t_abc001', 3, {}, 8));
    changes(200, { ...applied('c_cmd0001', 't_abc001', 3, {}), changes: [{ entity: 'task', id: 't_abc001', before: { revision: 3, row: taskRow('t_abc001') }, after: { revision: 4, deleted: true } }] });
    expect(await flushPendingOps(config)).toMatchObject({ flushed: 1 });
    expect(bodies('/api/v2/changes').map(b => b.commands[0].expectedStructuralRevision)).toEqual([7, 8]);
  });

  it('sends a client-ID create after asking only for the aggregate revision', async () => {
    await queue({ kind: 'task.create', id: 't_new001', title: 'Hello', notes: null, kickoffNote: null, taskType: 'action' }, null);
    entity(entityBody('t_new001', null));
    changes(200, { ...applied('c_cmd0001', 't_new001', 0, { title: 'Hello' }), changes: [{ entity: 'task', id: 't_new001', before: null, after: { revision: 1, row: taskRow('t_new001', { title: 'Hello' }) } }] });
    expect(await flushPendingOps(config)).toMatchObject({ flushed: 1 });
    expect(bodies('/api/v2/changes')[0]).toMatchObject({ commands: [{ kind: 'task.create', id: 't_new001', expectedRevision: null, expectedStructuralRevision: 7, values: { title: 'Hello' } }] });
  });

  it('a refused create retains the commands queued on its task as dependency failures', async () => {
    await queue({ kind: 'task.create', id: 't_new001', title: 'Hello', notes: null, kickoffNote: null, taskType: 'action' }, null, 'c_cmd0001');
    await queue({ kind: 'task.content', id: 't_new001', notes: 'later' }, 1, 'c_cmd0002');
    entity(entityBody('t_new001', null));
    changes(400, error('invalid_input'));
    await flushPendingOps(config);
    expect(await idbGetPendingOps()).toEqual([]);
    expect((await idbGetRetainedOps()).map(r => [r.op.op === 'command' ? r.op.intent.kind : '', r.reason.kind])).toEqual([['task.create', 'rejected'], ['task.content', 'dependency']]);
  });

  it('an edit to a task that no longer exists is retained without a changes request', async () => {
    await queue({ kind: 'task.focus', id: 't_abc001', focusedUntil: null }, 3);
    entity(entityBody('t_abc001', null));
    await flushPendingOps(config);
    expect(bodies('/api/v2/changes')).toHaveLength(0);
    expect(await idbGetRetainedOps()).toMatchObject([{ reason: { kind: 'rejected', status: 422 } }]);
  });

  it('server errors keep the command queued and halt the flush', async () => {
    await queue({ kind: 'task.reopen', id: 't_abc001' }, 3);
    await queue({ kind: 'task.reopen', id: 't_abc002' }, 3, 'c_cmd0002');
    entity(entityBody('t_abc001', 3));
    changes(503, { error: 'down' });
    expect(await flushPendingOps(config)).toMatchObject({ flushed: 0, halted: true });
    expect(await idbGetPendingOps()).toHaveLength(2);
    expect(await idbGetRetainedOps()).toEqual([]);
  });
});
