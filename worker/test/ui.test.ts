import { describe, expect, it } from 'vitest';
import type { Task } from '@shared/types';
import { handleUiRequest } from '../src/ui';
import { DomainOperationError } from '../src/db';

function taskRow(overrides: Partial<Task> = {}): Task {
  return {
    id: 't_abc12',
    title: 'Focused task',
    notes: null,
    status: 'pending',
    due_date: null,
    recurrence: null,
    created_at: '2026-05-15T12:00:00.000Z',
    updated_at: '2026-05-15T12:00:00.000Z',
    defer_until: null,
    defer_kind: 'none',
    task_type: 'action',
    project_id: null,
    kickoff_note: null,
    session_log: null,
    focused_until: null,
    ...overrides,
  };
}

function request(method: string, path: string): Request {
  return new Request(`http://127.0.0.1:8787${path}`, { method });
}

describe('UI route schemas', () => {
  it('does not normalize trailing slashes into complete requests', async () => {
    let called = false;
    const db = {
      completeTask: async () => {
        called = true;
        return { completed: taskRow() };
      },
    };

    const response = await handleUiRequest(
      request('POST', '/ui/complete/t_abc12/'),
      new URL('http://127.0.0.1:8787/ui/complete/t_abc12/'),
      db as never,
    );

    expect(response.status).toBe(404);
    expect(called).toBe(false);
    await expect(response.text()).resolves.toBe('Not found');
  });

  it('rejects malformed complete ids before calling the DB', async () => {
    let called = false;
    const db = {
      completeTask: async () => {
        called = true;
        return { completed: taskRow() };
      },
    };

    const response = await handleUiRequest(
      request('POST', '/ui/complete/not-a-task-id'),
      new URL('http://127.0.0.1:8787/ui/complete/not-a-task-id'),
      db as never,
    );

    expect(response.status).toBe(400);
    expect(called).toBe(false);
    await expect(response.json()).resolves.toMatchObject({
      details: [{ path: ['task_id'], code: 'regex' }],
    });
  });

  it('passes parsed complete ids to the DB', async () => {
    let completedId: string | undefined;
    const db = {
      completeTask: async (taskId: string) => {
        completedId = taskId;
        return { completed: taskRow({ id: taskId, status: 'done' }) };
      },
    };

    const response = await handleUiRequest(
      request('POST', '/ui/complete/t_abc12'),
      new URL('http://127.0.0.1:8787/ui/complete/t_abc12?t=123&sig=abc'),
      db as never,
    );

    expect(response.status).toBe(200);
    expect(completedId).toBe('t_abc12');
    await expect(response.json()).resolves.toMatchObject({
      completed: { id: 't_abc12', status: 'done' },
    });
  });

  it('maps complete transition failures to JSON errors', async () => {
    const db = {
      completeTask: async () => {
        throw new DomainOperationError({
          kind: 'invalid_transition',
          message: 'Only pending tasks can use this transition.',
        });
      },
    };

    const response = await handleUiRequest(
      request('POST', '/ui/complete/t_abc12'),
      new URL('http://127.0.0.1:8787/ui/complete/t_abc12'),
      db as never,
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: 'Only pending tasks can use this transition.',
    });
  });
});
