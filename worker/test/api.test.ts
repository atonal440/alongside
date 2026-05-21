import { describe, expect, it } from 'vitest';
import { handleApiRequest } from '../src/api';
import { DomainOperationError } from '../src/db';
import { validationErrorResult } from '../src/domain/errors';

function validationFailure(): DomainOperationError {
  return new DomainOperationError(validationErrorResult([{
    path: ['title'],
    code: 'max_length',
    message: 'Expected at most 200 characters.',
  }]));
}

function request(method: string, path: string, body: unknown): Request {
  return new Request(`http://127.0.0.1:8787${path}`, {
    method,
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('REST API project validation errors', () => {
  it('maps project create validation failures to 400 JSON', async () => {
    const db = {
      createProject: async () => {
        throw validationFailure();
      },
    };

    const response = await handleApiRequest(
      request('POST', '/api/projects', { title: 'x'.repeat(201) }),
      new URL('http://127.0.0.1:8787/api/projects'),
      db as never,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'Expected at most 200 characters.',
      details: [{ path: ['title'], code: 'max_length' }],
    });
  });

  it('maps project patch validation failures to 400 JSON', async () => {
    const db = {
      updateProject: async () => {
        throw validationFailure();
      },
    };

    const response = await handleApiRequest(
      request('PATCH', '/api/projects/p_abc12', { title: 'x'.repeat(201) }),
      new URL('http://127.0.0.1:8787/api/projects/p_abc12'),
      db as never,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: 'Expected at most 200 characters.',
      details: [{ path: ['title'], code: 'max_length' }],
    });
  });
});
