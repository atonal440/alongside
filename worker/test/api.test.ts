import { describe, expect, it } from 'vitest';
import { handleApiRequest } from '../src/api';
import { DB, DomainOperationError } from '../src/db';
import { validationErrorResult } from '../src/domain/errors';
import type { Task } from '@shared/types';

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

function importPayload(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    exported_at: '2026-05-15T12:00:00.000Z',
    projects: [],
    tasks: [],
    links: [],
    preferences: {},
    ...overrides,
  };
}

function validationFailure(): DomainOperationError {
  return new DomainOperationError(validationErrorResult([{
    path: ['title'],
    code: 'max_length',
    message: 'Expected at most 200 characters.',
  }]));
}

function request(method: string, path: string, body?: unknown): Request {
  const init: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  return new Request(`http://127.0.0.1:8787${path}`, init);
}

function rawJsonRequest(method: string, path: string, body: string): Request {
  return new Request(`http://127.0.0.1:8787${path}`, {
    method,
    body,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('REST API route schemas', () => {
  it('does not normalize trailing or repeated slashes into valid routes', async () => {
    const calls: string[] = [];
    const db = {
      listTasks: async () => {
        calls.push('listTasks');
        return [];
      },
      getTask: async () => {
        calls.push('getTask');
        return taskRow();
      },
      completeTask: async () => {
        calls.push('completeTask');
        return { completed: taskRow({ status: 'done' }) };
      },
    };

    const trailingList = await handleApiRequest(
      request('GET', '/api/tasks/'),
      new URL('http://127.0.0.1:8787/api/tasks/'),
      db as never,
    );
    const repeatedDynamic = await handleApiRequest(
      request('GET', '/api/tasks//t_abc12'),
      new URL('http://127.0.0.1:8787/api/tasks//t_abc12'),
      db as never,
    );
    const trailingMutation = await handleApiRequest(
      request('POST', '/api/tasks/t_abc12/complete/'),
      new URL('http://127.0.0.1:8787/api/tasks/t_abc12/complete/'),
      db as never,
    );

    expect(trailingList.status).toBe(404);
    expect(repeatedDynamic.status).toBe(404);
    expect(trailingMutation.status).toBe(404);
    expect(calls).toEqual([]);
  });

  it('keeps unsupported static subroute methods as not found', async () => {
    const calls: string[] = [];
    const db = {
      updateTask: async () => {
        calls.push('updateTask');
        return taskRow();
      },
      completeTask: async () => {
        calls.push('completeTask');
        return { completed: taskRow({ status: 'done' }) };
      },
      updateProject: async () => {
        calls.push('updateProject');
        return { id: 'p_abc12' };
      },
    };

    const taskSyncPatch = await handleApiRequest(
      request('PATCH', '/api/tasks/sync', { title: 'Nope' }),
      new URL('http://127.0.0.1:8787/api/tasks/sync'),
      db as never,
    );
    const taskLinksComplete = await handleApiRequest(
      request('POST', '/api/tasks/links/complete'),
      new URL('http://127.0.0.1:8787/api/tasks/links/complete'),
      db as never,
    );
    const projectSyncPatch = await handleApiRequest(
      request('PATCH', '/api/projects/sync', { title: 'Nope' }),
      new URL('http://127.0.0.1:8787/api/projects/sync'),
      db as never,
    );

    expect(taskSyncPatch.status).toBe(404);
    expect(taskLinksComplete.status).toBe(404);
    expect(projectSyncPatch.status).toBe(404);
    expect(calls).toEqual([]);
  });

  it('rejects malformed task ids before calling the DB', async () => {
    let called = false;
    const db = {
      getTask: async () => {
        called = true;
        return taskRow();
      },
    };

    const response = await handleApiRequest(
      request('GET', '/api/tasks/not-a-task-id'),
      new URL('http://127.0.0.1:8787/api/tasks/not-a-task-id'),
      db as never,
    );

    expect(response.status).toBe(400);
    expect(called).toBe(false);
    await expect(response.json()).resolves.toMatchObject({
      details: [{ path: ['task_id'], code: 'regex' }],
    });
  });

  it('rejects malformed project ids before calling the DB', async () => {
    let called = false;
    const db = {
      getProject: async () => {
        called = true;
        return { id: 'p_abc12' };
      },
    };

    const response = await handleApiRequest(
      request('GET', '/api/projects/not-a-project-id'),
      new URL('http://127.0.0.1:8787/api/projects/not-a-project-id'),
      db as never,
    );

    expect(response.status).toBe(400);
    expect(called).toBe(false);
    await expect(response.json()).resolves.toMatchObject({
      details: [{ path: ['project_id'], code: 'regex' }],
    });
  });

  it('rejects invalid task bodies before calling the DB', async () => {
    let called = false;
    const db = {
      addTask: async () => {
        called = true;
        return taskRow();
      },
    };

    const response = await handleApiRequest(
      request('POST', '/api/tasks', { title: 'Bad date', due_date: 'tomorrow' }),
      new URL('http://127.0.0.1:8787/api/tasks'),
      db as never,
    );

    expect(response.status).toBe(400);
    expect(called).toBe(false);
    await expect(response.json()).resolves.toMatchObject({
      details: [{ path: ['due_date'] }],
    });
  });

  it('rejects invalid task update bodies before calling the DB', async () => {
    let called = false;
    const db = {
      updateTask: async () => {
        called = true;
        return taskRow();
      },
    };

    const response = await handleApiRequest(
      request('PATCH', '/api/tasks/t_abc12', { focused_until: 'soon' }),
      new URL('http://127.0.0.1:8787/api/tasks/t_abc12'),
      db as never,
    );

    expect(response.status).toBe(400);
    expect(called).toBe(false);
    await expect(response.json()).resolves.toMatchObject({
      details: [{ path: ['focused_until'] }],
    });
  });

  it('rejects invalid task link bodies before calling the DB', async () => {
    let called = false;
    const db = {
      linkTasks: async () => {
        called = true;
      },
    };

    const response = await handleApiRequest(
      request('POST', '/api/tasks/links', {
        from_task_id: 'bad',
        to_task_id: 't_abc12',
        link_type: 'blocks',
      }),
      new URL('http://127.0.0.1:8787/api/tasks/links'),
      db as never,
    );

    expect(response.status).toBe(400);
    expect(called).toBe(false);
    await expect(response.json()).resolves.toMatchObject({
      details: [{ path: ['from_task_id'], code: 'regex' }],
    });
  });

  it('rejects invalid project bodies before calling the DB', async () => {
    let called = false;
    const db = {
      createProject: async () => {
        called = true;
        return { id: 'p_abc12' };
      },
    };

    const response = await handleApiRequest(
      request('POST', '/api/projects', { title: '   ' }),
      new URL('http://127.0.0.1:8787/api/projects'),
      db as never,
    );

    expect(response.status).toBe(400);
    expect(called).toBe(false);
    await expect(response.json()).resolves.toMatchObject({
      details: [{ path: ['title'] }],
    });
  });

  it('rejects invalid export query params before calling the DB', async () => {
    let called = false;
    const db = {
      exportAll: async () => {
        called = true;
        return { version: 1 };
      },
    };

    const response = await handleApiRequest(
      request('GET', '/api/export?include_log=yes'),
      new URL('http://127.0.0.1:8787/api/export?include_log=yes'),
      db as never,
    );

    expect(response.status).toBe(400);
    expect(called).toBe(false);
    await expect(response.json()).resolves.toMatchObject({
      details: [{ path: ['include_log'] }],
    });
  });

  it('rejects invalid import query params before reading the body', async () => {
    let called = false;
    const db = {
      importAll: async () => {
        called = true;
        return { dry_run: true };
      },
    };

    const response = await handleApiRequest(
      request('POST', '/api/import?dry_run=1'),
      new URL('http://127.0.0.1:8787/api/import?dry_run=1'),
      db as never,
    );

    expect(response.status).toBe(400);
    expect(called).toBe(false);
    await expect(response.json()).resolves.toMatchObject({
      details: [{ path: ['dry_run'] }],
    });
  });

  it('returns existing prefixed import body validation paths', async () => {
    const response = await handleApiRequest(
      request('POST', '/api/import', { version: 1 }),
      new URL('http://127.0.0.1:8787/api/import'),
      new DB({} as ConstructorParameters<typeof DB>[0]),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      details: expect.arrayContaining([
        expect.objectContaining({ path: ['payload', 'exported_at'] }),
        expect.objectContaining({ path: ['payload', 'projects'] }),
      ]),
    });
  });

  it('preserves the import invalid JSON error shape', async () => {
    const response = await handleApiRequest(
      rawJsonRequest('POST', '/api/import', '{'),
      new URL('http://127.0.0.1:8787/api/import'),
      new DB({} as ConstructorParameters<typeof DB>[0]),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'Invalid JSON body' });
  });

  it('passes parsed task create bodies to the DB', async () => {
    let received: unknown;
    const db = {
      addTask: async (body: unknown) => {
        received = body;
        return taskRow({ title: 'Write tests', due_date: '2026-05-21' });
      },
    };

    const response = await handleApiRequest(
      request('POST', '/api/tasks', {
        title: 'Write tests',
        due_date: '2026-05-21',
        task_type: 'plan',
      }),
      new URL('http://127.0.0.1:8787/api/tasks'),
      db as never,
    );

    expect(response.status).toBe(201);
    expect(received).toMatchObject({
      title: 'Write tests',
      due_date: '2026-05-21',
      task_type: 'plan',
    });
    await expect(response.json()).resolves.toMatchObject({
      title: 'Write tests',
      due_date: '2026-05-21',
    });
  });

  it('passes parsed task link bodies to the DB', async () => {
    let received: unknown[] | undefined;
    const db = {
      linkTasks: async (...args: unknown[]) => {
        received = args;
      },
    };

    const response = await handleApiRequest(
      request('POST', '/api/tasks/links', {
        from_task_id: 't_from1',
        to_task_id: 't_to222',
        link_type: 'blocks',
      }),
      new URL('http://127.0.0.1:8787/api/tasks/links'),
      db as never,
    );

    expect(response.status).toBe(201);
    expect(received).toEqual(['t_from1', 't_to222', 'blocks']);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it('passes parsed project patch bodies to the DB', async () => {
    let receivedId: string | undefined;
    let receivedPatch: unknown;
    const db = {
      updateProject: async (id: string, patch: unknown) => {
        receivedId = id;
        receivedPatch = patch;
        return {
          id,
          title: 'Launch',
          notes: 'Updated notes',
          kickoff_note: null,
          status: 'archived',
          created_at: '2026-05-15T12:00:00.000Z',
          updated_at: '2026-05-15T12:00:00.000Z',
        };
      },
    };

    const response = await handleApiRequest(
      request('PATCH', '/api/projects/p_abc12', {
        notes: 'Updated notes',
        status: 'archived',
      }),
      new URL('http://127.0.0.1:8787/api/projects/p_abc12'),
      db as never,
    );

    expect(response.status).toBe(200);
    expect(receivedId).toBe('p_abc12');
    expect(receivedPatch).toMatchObject({ notes: 'Updated notes', status: 'archived' });
    await expect(response.json()).resolves.toMatchObject({ id: 'p_abc12', status: 'archived' });
  });

  it('passes strict boolean query params to export', async () => {
    let includeLog: boolean | undefined;
    const db = {
      exportAll: async (value: boolean) => {
        includeLog = value;
        return {
          version: 1,
          exported_at: '2026-05-15T12:00:00.000Z',
          projects: [],
          tasks: [],
          links: [],
          preferences: {},
          action_log: [],
        };
      },
    };

    const response = await handleApiRequest(
      request('GET', '/api/export?include_log=true'),
      new URL('http://127.0.0.1:8787/api/export?include_log=true'),
      db as never,
    );

    expect(response.status).toBe(200);
    expect(includeLog).toBe(true);
    expect(response.headers.get('Content-Disposition')).toContain('alongside-export-');
  });

  it('defaults absent export query params to false', async () => {
    let includeLog: boolean | undefined;
    const db = {
      exportAll: async (value: boolean) => {
        includeLog = value;
        return {
          version: 1,
          exported_at: '2026-05-15T12:00:00.000Z',
          projects: [],
          tasks: [],
          links: [],
          preferences: {},
        };
      },
    };

    const response = await handleApiRequest(
      request('GET', '/api/export'),
      new URL('http://127.0.0.1:8787/api/export'),
      db as never,
    );

    expect(response.status).toBe(200);
    expect(includeLog).toBe(false);
  });

  it('passes parsed dry-run import bodies to the DB', async () => {
    let receivedPayload: unknown;
    let dryRun: boolean | undefined;
    const db = {
      importAll: async (payload: unknown, value: boolean) => {
        receivedPayload = payload;
        dryRun = value;
        return {
          dry_run: value,
          would_delete: { tasks: 0, projects: 0 },
          would_insert: { tasks: 0, projects: 0 },
        };
      },
    };

    const response = await handleApiRequest(
      request('POST', '/api/import?dry_run=true', importPayload()),
      new URL('http://127.0.0.1:8787/api/import?dry_run=true'),
      db as never,
    );

    expect(response.status).toBe(200);
    expect(dryRun).toBe(true);
    expect(receivedPayload).toMatchObject({ version: 1, projects: [], tasks: [] });
    await expect(response.json()).resolves.toMatchObject({ dry_run: true });
  });

  it('defaults absent import query params to false', async () => {
    let dryRun: boolean | undefined;
    const db = {
      importAll: async (_payload: unknown, value: boolean) => {
        dryRun = value;
        return {
          dry_run: value,
          inserted: { projects: 0, tasks: 0, links: 0, preferences: 0, action_log: 0 },
        };
      },
    };

    const response = await handleApiRequest(
      request('POST', '/api/import', importPayload()),
      new URL('http://127.0.0.1:8787/api/import'),
      db as never,
    );

    expect(response.status).toBe(201);
    expect(dryRun).toBe(false);
    await expect(response.json()).resolves.toMatchObject({ dry_run: false });
  });
});

describe('REST API project validation errors', () => {
  it('maps project create validation failures to 400 JSON', async () => {
    const db = {
      createProject: async () => {
        throw validationFailure();
      },
    };

    const response = await handleApiRequest(
      request('POST', '/api/projects', { title: 'Valid project' }),
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
      request('PATCH', '/api/projects/p_abc12', { title: 'Valid project' }),
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
