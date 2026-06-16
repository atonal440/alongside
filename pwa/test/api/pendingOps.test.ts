import { describe, test, expect, afterEach } from 'vitest';
import { toRequest, rebindTaskId, parsePendingOp } from '../../src/api/pendingOps';
import type { PendingOp } from '../../src/api/pendingOps';
import type { ApiConfig } from '../../src/api/client';
import { installFetchStub } from '../helpers/fetchStub';
import { makeTask } from '../helpers/fixtures';

const config: ApiConfig = { apiBase: 'http://localhost:8787', authToken: 'tok' };
const AT = '2026-06-16T10:00:00.000Z';

function base(extra: object): PendingOp {
  return { created_at: AT, attempts: 0, ...extra } as PendingOp;
}

afterEach(() => {});

// ─── toRequest ───────────────────────────────────────────────────────────────

describe('toRequest', () => {
  test('task.create → POST /api/tasks with body', async () => {
    const stub = installFetchStub();
    stub.respondWith({ method: 'POST', path: '/api/tasks' }, {
      type: 'json', status: 200, body: makeTask(),
    });
    const op = base({ op: 'task.create', localId: 't_local1', body: { title: 'Hello' } });
    const result = await toRequest(op, config);
    stub.restore();
    expect(result.kind).toBe('ok');
    expect(stub.calls[0]!.method).toBe('POST');
    expect(stub.calls[0]!.path).toContain('/api/tasks');
    expect((stub.calls[0]!.body as Record<string, unknown>).title).toBe('Hello');
  });

  test('task.update → PATCH /api/tasks/:id with body', async () => {
    const stub = installFetchStub();
    stub.respondWith({ method: 'PATCH', path: '/api/tasks/t_abc' }, {
      type: 'json', status: 200, body: makeTask({ id: 't_abc001' }),
    });
    const op = base({ op: 'task.update', taskId: 't_abc001', body: { title: 'Updated' } });
    const result = await toRequest(op, config);
    stub.restore();
    expect(result.kind).toBe('ok');
    expect(stub.calls[0]!.method).toBe('PATCH');
    expect(stub.calls[0]!.path).toContain('t_abc001');
    expect((stub.calls[0]!.body as Record<string, unknown>).title).toBe('Updated');
  });

  test('task.complete → POST /api/tasks/:id/complete', async () => {
    const stub = installFetchStub();
    stub.respondWith({ method: 'POST', path: '/complete' }, {
      type: 'json', status: 200,
      body: { completed: makeTask({ id: 't_abc001', status: 'done' }) },
    });
    const op = base({ op: 'task.complete', taskId: 't_abc001' });
    await toRequest(op, config);
    stub.restore();
    expect(stub.calls[0]!.path).toContain('/complete');
  });

  test('task.delete → DELETE /api/tasks/:id', async () => {
    const stub = installFetchStub();
    stub.respondWith({ method: 'DELETE', path: '/api/tasks/t_abc' }, {
      type: 'json', status: 200, body: { ok: true },
    });
    const op = base({ op: 'task.delete', taskId: 't_abc001' });
    await toRequest(op, config);
    stub.restore();
    expect(stub.calls[0]!.method).toBe('DELETE');
    expect(stub.calls[0]!.path).toContain('t_abc001');
  });

  test('link.create → POST /api/tasks/links', async () => {
    const stub = installFetchStub();
    stub.respondWith({ method: 'POST', path: '/api/tasks/links' }, {
      type: 'json', status: 200, body: { ok: true },
    });
    const op = base({ op: 'link.create', body: { from_task_id: 't_a00001', to_task_id: 't_b00001', link_type: 'blocks' } });
    await toRequest(op, config);
    stub.restore();
    expect(stub.calls[0]!.method).toBe('POST');
    expect(stub.calls[0]!.path).toContain('/api/tasks/links');
  });

  test('link.delete → DELETE /api/tasks/links', async () => {
    const stub = installFetchStub();
    stub.respondWith({ method: 'DELETE', path: '/api/tasks/links' }, {
      type: 'json', status: 200, body: { ok: true },
    });
    const op = base({ op: 'link.delete', body: { from_task_id: 't_a00001', to_task_id: 't_b00001', link_type: 'blocks' } });
    await toRequest(op, config);
    stub.restore();
    expect(stub.calls[0]!.method).toBe('DELETE');
  });
});

// ─── rebindTaskId ─────────────────────────────────────────────────────────────

describe('rebindTaskId', () => {
  const OLD = 't_old001';
  const NEW = 't_new001';

  test('task.create: localId matches → rebound', () => {
    const op = base({ op: 'task.create', localId: OLD, body: { title: 'X' } });
    const r = rebindTaskId(op, OLD, NEW);
    expect((r as Extract<PendingOp, { op: 'task.create' }>).localId).toBe(NEW);
  });

  test('task.create: localId absent → unchanged (reference equal)', () => {
    const op = base({ op: 'task.create', localId: 't_other1', body: { title: 'X' } });
    expect(rebindTaskId(op, OLD, NEW)).toBe(op);
  });

  test('task.update: taskId matches → rebound', () => {
    const op = base({ op: 'task.update', taskId: OLD, body: {} });
    const r = rebindTaskId(op, OLD, NEW);
    expect((r as Extract<PendingOp, { op: 'task.update' }>).taskId).toBe(NEW);
  });

  test('task.update: taskId absent → unchanged', () => {
    const op = base({ op: 'task.update', taskId: 't_other1', body: {} });
    expect(rebindTaskId(op, OLD, NEW)).toBe(op);
  });

  test('task.complete: taskId matches → rebound', () => {
    const op = base({ op: 'task.complete', taskId: OLD });
    const r = rebindTaskId(op, OLD, NEW);
    expect((r as Extract<PendingOp, { op: 'task.complete' }>).taskId).toBe(NEW);
  });

  test('task.complete: taskId absent → unchanged', () => {
    const op = base({ op: 'task.complete', taskId: 't_other1' });
    expect(rebindTaskId(op, OLD, NEW)).toBe(op);
  });

  test('task.delete: taskId matches → rebound', () => {
    const op = base({ op: 'task.delete', taskId: OLD });
    const r = rebindTaskId(op, OLD, NEW);
    expect((r as Extract<PendingOp, { op: 'task.delete' }>).taskId).toBe(NEW);
  });

  test('task.delete: taskId absent → unchanged', () => {
    const op = base({ op: 'task.delete', taskId: 't_other1' });
    expect(rebindTaskId(op, OLD, NEW)).toBe(op);
  });

  test('link.create: from_task_id matches → rebound', () => {
    const op = base({ op: 'link.create', body: { from_task_id: OLD, to_task_id: 't_b00001', link_type: 'blocks' } });
    const r = rebindTaskId(op, OLD, NEW) as Extract<PendingOp, { op: 'link.create' }>;
    expect(r.body.from_task_id).toBe(NEW);
    expect(r.body.to_task_id).toBe('t_b00001');
  });

  test('link.create: to_task_id matches → rebound', () => {
    const op = base({ op: 'link.create', body: { from_task_id: 't_a00001', to_task_id: OLD, link_type: 'blocks' } });
    const r = rebindTaskId(op, OLD, NEW) as Extract<PendingOp, { op: 'link.create' }>;
    expect(r.body.from_task_id).toBe('t_a00001');
    expect(r.body.to_task_id).toBe(NEW);
  });

  test('link.create: neither matches → unchanged', () => {
    const op = base({ op: 'link.create', body: { from_task_id: 't_a00001', to_task_id: 't_b00001', link_type: 'blocks' } });
    expect(rebindTaskId(op, OLD, NEW)).toBe(op);
  });

  test('link.delete: from_task_id matches → rebound', () => {
    const op = base({ op: 'link.delete', body: { from_task_id: OLD, to_task_id: 't_b00001', link_type: 'blocks' } });
    const r = rebindTaskId(op, OLD, NEW) as Extract<PendingOp, { op: 'link.delete' }>;
    expect(r.body.from_task_id).toBe(NEW);
  });

  test('link.delete: neither matches → unchanged', () => {
    const op = base({ op: 'link.delete', body: { from_task_id: 't_a00001', to_task_id: 't_b00001', link_type: 'blocks' } });
    expect(rebindTaskId(op, OLD, NEW)).toBe(op);
  });

  // Substring safety: 't_old001' should not be rewritten when searching for 't_old'
  test('oldId-as-substring of another id is not rewritten', () => {
    const SHORT_OLD = 't_old';
    const op = base({ op: 'task.update', taskId: 't_old001', body: {} });
    expect(rebindTaskId(op, SHORT_OLD, NEW)).toBe(op);
  });
});

// ─── parsePendingOp ───────────────────────────────────────────────────────────

describe('parsePendingOp', () => {
  const baseFields = { created_at: AT, attempts: 0 };

  test('accepts task.create', () => {
    const r = parsePendingOp({ ...baseFields, op: 'task.create', localId: 't_loc001', body: { title: 'Hi' } });
    expect(r.ok).toBe(true);
  });

  test('accepts task.update', () => {
    const r = parsePendingOp({ ...baseFields, op: 'task.update', taskId: 't_abc001', body: { title: 'Updated' } });
    expect(r.ok).toBe(true);
  });

  test('accepts task.complete', () => {
    const r = parsePendingOp({ ...baseFields, op: 'task.complete', taskId: 't_abc001' });
    expect(r.ok).toBe(true);
  });

  test('accepts task.delete', () => {
    const r = parsePendingOp({ ...baseFields, op: 'task.delete', taskId: 't_abc001' });
    expect(r.ok).toBe(true);
  });

  test('accepts link.create', () => {
    const r = parsePendingOp({ ...baseFields, op: 'link.create', body: { from_task_id: 't_a00001', to_task_id: 't_b00001', link_type: 'blocks' } });
    expect(r.ok).toBe(true);
  });

  test('accepts link.delete', () => {
    const r = parsePendingOp({ ...baseFields, op: 'link.delete', body: { from_task_id: 't_a00001', to_task_id: 't_b00001', link_type: 'blocks' } });
    expect(r.ok).toBe(true);
  });

  test('rejects unknown op', () => {
    const r = parsePendingOp({ ...baseFields, op: 'task.unknown', taskId: 't_abc001' });
    expect(r.ok).toBe(false);
  });

  test('rejects missing op field', () => {
    const r = parsePendingOp({ ...baseFields, taskId: 't_abc001' });
    expect(r.ok).toBe(false);
  });

  test('rejects missing required field (task.create body missing title)', () => {
    const r = parsePendingOp({ ...baseFields, op: 'task.create', localId: 't_loc001', body: {} });
    expect(r.ok).toBe(false);
  });

  test('rejects wrong field type (attempts is string)', () => {
    const r = parsePendingOp({ ...baseFields, attempts: 'zero', op: 'task.delete', taskId: 't_abc001' });
    expect(r.ok).toBe(false);
  });

  test('preserves optional id field', () => {
    const r = parsePendingOp({ id: 42, ...baseFields, op: 'task.delete', taskId: 't_abc001' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.id).toBe(42);
  });
});
