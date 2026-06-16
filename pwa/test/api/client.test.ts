import { describe, test, expect, vi, afterEach } from 'vitest';
import { apiRequest, type ApiConfig } from '../../src/api/client';
import { installFetchStub } from '../helpers/fetchStub';
import { makeTask } from '../helpers/fixtures';
import { parseTaskRow } from '@shared/wire/rows';

const config: ApiConfig = { apiBase: 'http://localhost:8787', authToken: 'tok' };
const emptyConfig: ApiConfig = { apiBase: '', authToken: '' };

afterEach(() => { vi.restoreAllMocks(); });

describe('apiRequest', () => {
  test('ok JSON parses through schema', async () => {
    const stub = installFetchStub();
    stub.respondWith({ method: 'GET', path: '/api/tasks/sync' }, {
      type: 'json', status: 200, body: makeTask(),
    });
    const result = await apiRequest('/api/tasks/sync', {}, config, parseTaskRow);
    stub.restore();
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') expect(result.value.id).toBe('t_test1');
  });

  test('non-OK with {error, details} body → http with parsed details', async () => {
    const stub = installFetchStub();
    stub.respondWith({ method: 'POST', path: '/api/tasks' }, {
      type: 'json', status: 400,
      body: { error: 'Validation failed', details: [{ path: ['title'], code: 'too_short', message: 'Too short' }] },
    });
    const result = await apiRequest('/api/tasks', { method: 'POST' }, config, parseTaskRow);
    stub.restore();
    expect(result.kind).toBe('http');
    if (result.kind === 'http') {
      expect(result.status).toBe(400);
      expect(result.body.error).toBe('Validation failed');
      expect(result.body.details).toHaveLength(1);
    }
  });

  test('non-OK with non-JSON body → http with degraded message', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response('<html>Error</html>', {
      status: 500, headers: { 'Content-Type': 'text/html' },
    });
    const result = await apiRequest('/api/tasks', {}, config, parseTaskRow);
    globalThis.fetch = original;
    expect(result.kind).toBe('http');
    if (result.kind === 'http') {
      expect(result.status).toBe(500);
      expect(result.body.error).toBe('HTTP 500');
    }
  });

  test('fetch rejection → network', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => { throw new TypeError('fetch failed'); };
    const result = await apiRequest('/api/tasks', {}, config, parseTaskRow);
    globalThis.fetch = original;
    expect(result.kind).toBe('network');
  });

  test('empty apiBase → unconfigured without calling fetch', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    const result = await apiRequest('/api/tasks', {}, emptyConfig, parseTaskRow);
    expect(result.kind).toBe('unconfigured');
    expect(spy).not.toHaveBeenCalled();
  });

  test('OK-but-malformed body → contract, console.error called', async () => {
    const stub = installFetchStub();
    stub.respondWith({ method: 'POST', path: '/api/tasks' }, {
      type: 'json', status: 200,
      // Missing id — parseTaskRow should fail
      body: { title: 'No ID here', status: 'pending' },
    });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await apiRequest('/api/tasks', { method: 'POST' }, config, parseTaskRow);
    stub.restore();
    expect(result.kind).toBe('contract');
    expect(spy).toHaveBeenCalled();
  });
});
