import { DB, Task } from './db';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export async function handleApiRequest(request: Request, url: URL, db: DB): Promise<Response> {
  const method = request.method;
  const path = url.pathname;

  // GET /api/tasks — list all non-done tasks
  if (method === 'GET' && path === '/api/tasks') {
    const tasks = await db.listTasks(['pending', 'active', 'snoozed']);
    return json(tasks);
  }

  // GET /api/tasks/sync — all tasks including done, for full PWA sync
  if (method === 'GET' && path === '/api/tasks/sync') {
    const tasks = await db.listTasks(['pending', 'active', 'snoozed', 'done']);
    return json(tasks);
  }

  // GET /api/tasks/:id — get one task
  const singleMatch = path.match(/^\/api\/tasks\/([^/]+)$/);
  if (method === 'GET' && singleMatch) {
    const task = await db.getTask(singleMatch[1]);
    if (!task) return json({ error: 'Not found' }, 404);
    return json(task);
  }

  // POST /api/tasks — create task
  if (method === 'POST' && path === '/api/tasks') {
    const body = await request.json<{ title: string; notes?: string; due_date?: string; recurrence?: string }>();
    if (!body.title) return json({ error: 'title is required' }, 400);
    const task = await db.addTask(body);
    return json(task, 201);
  }

  // PATCH /api/tasks/:id — update task
  if (method === 'PATCH' && singleMatch) {
    const body = await request.json<{ title?: string; notes?: string; due_date?: string; recurrence?: string; kickoff_note?: string; status?: 'pending' | 'active' | 'snoozed'; snoozed_until?: string }>();
    const task = await db.updateTask(singleMatch[1], body);
    if (!task) return json({ error: 'Not found' }, 404);
    return json(task);
  }

  // DELETE /api/tasks/:id — hard delete
  if (method === 'DELETE' && singleMatch) {
    const deleted = await db.deleteTask(singleMatch[1]);
    if (!deleted) return json({ error: 'Not found' }, 404);
    return json({ ok: true });
  }

  // POST /api/tasks/:id/complete — complete + handle recurrence
  const completeMatch = path.match(/^\/api\/tasks\/([^/]+)\/complete$/);
  if (method === 'POST' && completeMatch) {
    const result = await db.completeTask(completeMatch[1]);
    if (!result) return json({ error: 'Not found' }, 404);
    return json(result);
  }

  // GET /api/projects — list active projects
  if (method === 'GET' && path === '/api/projects') {
    const projects = await db.listProjects('active');
    return json(projects);
  }

  // GET /api/tasks/links — all task link relationships
  if (method === 'GET' && path === '/api/tasks/links') {
    const links = await db.listAllLinks();
    return json(links);
  }

  // GET /api/action-log — recent operations, newest first
  if (method === 'GET' && path === '/api/action-log') {
    const entries = await db.getActionLog();
    return json(entries);
  }

  return json({ error: 'Not found' }, 404);
}
