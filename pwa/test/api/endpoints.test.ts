import { describe, test, expect, afterEach } from 'vitest';
import { api } from '../../src/api/endpoints';
import { installFetchStub } from '../helpers/fetchStub';
import { makeTask, makeProject, makeLink } from '../helpers/fixtures';
import type { ApiConfig } from '../../src/api/client';

const config: ApiConfig = { apiBase: 'http://localhost:8787', authToken: 'tok' };

afterEach(() => {});

// --- createTask ---

describe('api.createTask', () => {
  test('POST /api/tasks with body, parses task row', async () => {
    const stub = installFetchStub();
    stub.respondWith({ method: 'POST', path: '/api/tasks' }, {
      type: 'json', status: 200, body: makeTask({ title: 'Buy milk' }),
    });
    const result = await api.createTask({ title: 'Buy milk' }, config);
    stub.restore();
    expect(result.kind).toBe('ok');
    const call = stub.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.path).toContain('/api/tasks');
    expect((call.body as Record<string, unknown>).title).toBe('Buy milk');
    if (result.kind === 'ok') expect(result.value.title).toBe('Buy milk');
  });

  test('stubbed { ok: true } → contract (wrong schema for task)', async () => {
    const stub = installFetchStub();
    stub.respondWith({ method: 'POST', path: '/api/tasks' }, {
      type: 'json', status: 200, body: { ok: true },
    });
    const result = await api.createTask({ title: 'x' }, config);
    stub.restore();
    expect(result.kind).toBe('contract');
  });
});

// --- updateTask ---

describe('api.updateTask', () => {
  test('PATCH /api/tasks/:id with body, parses task row', async () => {
    const stub = installFetchStub();
    stub.respondWith({ method: 'PATCH', path: '/api/tasks/t_test1' }, {
      type: 'json', status: 200, body: makeTask({ id: 't_test1', title: 'Updated' }),
    });
    const result = await api.updateTask('t_test1', { title: 'Updated' }, config);
    stub.restore();
    expect(result.kind).toBe('ok');
    const call = stub.calls[0]!;
    expect(call.method).toBe('PATCH');
    expect(call.path).toContain('/api/tasks/t_test1');
  });
});

// --- deleteTask ---

describe('api.deleteTask', () => {
  test('DELETE /api/tasks/:id, { ok: true } → ok', async () => {
    const stub = installFetchStub();
    stub.respondWith({ method: 'DELETE', path: '/api/tasks/t_test1' }, {
      type: 'json', status: 200, body: { ok: true },
    });
    const result = await api.deleteTask('t_test1', config);
    stub.restore();
    expect(result.kind).toBe('ok');
    const call = stub.calls[0]!;
    expect(call.method).toBe('DELETE');
    expect(call.path).toContain('/api/tasks/t_test1');
  });

  test('task row response → contract (wrong schema)', async () => {
    const stub = installFetchStub();
    stub.respondWith({ method: 'DELETE', path: '/api/tasks/t_test1' }, {
      type: 'json', status: 200, body: makeTask(),
    });
    const result = await api.deleteTask('t_test1', config);
    stub.restore();
    expect(result.kind).toBe('contract');
  });
});

// --- completeTask ---

describe('api.completeTask', () => {
  test('POST /api/tasks/:id/complete, parses completed + next', async () => {
    const next = makeTask({ id: 't_test2', due_date: '2026-07-01' });
    const stub = installFetchStub();
    stub.respondWith({ method: 'POST', path: '/api/tasks/t_test1/complete' }, {
      type: 'json', status: 200,
      body: { completed: makeTask({ id: 't_test1', status: 'done' }), next },
    });
    const result = await api.completeTask('t_test1', config);
    stub.restore();
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.value.completed.id).toBe('t_test1');
      expect(result.value.next?.id).toBe('t_test2');
    }
  });

  test('absent next field is ok', async () => {
    const stub = installFetchStub();
    stub.respondWith({ method: 'POST', path: '/api/tasks/t_test1/complete' }, {
      type: 'json', status: 200,
      body: { completed: makeTask({ id: 't_test1', status: 'done' }) },
    });
    const result = await api.completeTask('t_test1', config);
    stub.restore();
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.value.next).toBeUndefined();
  });
});

// --- syncTasks ---

describe('api.syncTasks', () => {
  test('GET /api/tasks/sync, parses array of task rows', async () => {
    const stub = installFetchStub();
    stub.respondWith({ method: 'GET', path: '/api/tasks/sync' }, {
      type: 'json', status: 200, body: [makeTask(), makeTask({ id: 't_test2', title: 'Task 2' })],
    });
    const result = await api.syncTasks(config);
    stub.restore();
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.value).toHaveLength(2);
    const call = stub.calls[0]!;
    expect(call.method).toBe('GET');
    expect(call.path).toContain('/api/tasks/sync');
  });
});

// --- syncProjects ---

describe('api.syncProjects', () => {
  test('GET /api/projects/sync, parses array of project rows', async () => {
    const stub = installFetchStub();
    stub.respondWith({ method: 'GET', path: '/api/projects/sync' }, {
      type: 'json', status: 200, body: [makeProject()],
    });
    const result = await api.syncProjects(config);
    stub.restore();
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.value[0]!.id).toBe('p_test1');
  });
});

// --- listLinks ---

describe('api.listLinks', () => {
  test('GET /api/tasks/links, parses array of link rows', async () => {
    const stub = installFetchStub();
    stub.respondWith({ method: 'GET', path: '/api/tasks/links' }, {
      type: 'json', status: 200, body: [makeLink()],
    });
    const result = await api.listLinks(config);
    stub.restore();
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.value[0]!.link_type).toBe('blocks');
  });
});

// --- createLink ---

describe('api.createLink', () => {
  test('POST /api/tasks/links with body, { ok: true } → ok', async () => {
    const stub = installFetchStub();
    stub.respondWith({ method: 'POST', path: '/api/tasks/links' }, {
      type: 'json', status: 201, body: { ok: true },
    });
    const body = { from_task_id: 't_from1', to_task_id: 't_to001', link_type: 'blocks' as const };
    const result = await api.createLink(body, config);
    stub.restore();
    expect(result.kind).toBe('ok');
    const call = stub.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.path).toContain('/api/tasks/links');
    const sent = call.body as typeof body;
    expect(sent.from_task_id).toBe('t_from1');
  });
});

// --- deleteLink ---

describe('api.deleteLink', () => {
  test('DELETE /api/tasks/links with body, { ok: true } → ok', async () => {
    const stub = installFetchStub();
    stub.respondWith({ method: 'DELETE', path: '/api/tasks/links' }, {
      type: 'json', status: 200, body: { ok: true },
    });
    const body = { from_task_id: 't_from1', to_task_id: 't_to001', link_type: 'blocks' as const };
    const result = await api.deleteLink(body, config);
    stub.restore();
    expect(result.kind).toBe('ok');
    const call = stub.calls[0]!;
    expect(call.method).toBe('DELETE');
  });
});
