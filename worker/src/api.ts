import { DB, LegacyRecurringTaskNeedsTimezoneError, TaskRecurrenceUnsupportedError } from './db';
import type { ExportPayload } from './db';
import type { TaskLink, ProjectUpdate, DutyUpdate } from '@shared/types';
import { materializeDueDuties, dateAtMidnightInTz, todayInTz, getUserTimezone, computeNextFire, isValidTimezone, isValidDateOnly } from './duties';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function isSupportedDutySchedule(recurrence: string, nextFireAt: string, tz: string): boolean {
  try {
    return computeNextFire(recurrence, nextFireAt, tz) !== null;
  } catch {
    return false;
  }
}

function firstFireDateToNextFireAt(firstFireDate: string, tz: string): string | null {
  if (!isValidDateOnly(firstFireDate)) return null;
  try {
    return dateAtMidnightInTz(firstFireDate, tz);
  } catch {
    return null;
  }
}

function normalizeIsoInstant(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString();
}

function isValidDutyOffsetDays(value: unknown): value is number {
  return Number.isInteger(value) && Number.isFinite(value);
}

export async function handleApiRequest(request: Request, url: URL, db: DB): Promise<Response> {
  const method = request.method;
  const path = url.pathname;

  // GET /api/tasks — list all non-done tasks
  if (method === 'GET' && path === '/api/tasks') {
    await materializeDueDuties(db, new Date().toISOString());
    const tasks = await db.listTasks();
    return json(tasks);
  }

  // GET /api/tasks/sync — all tasks including done and deferred, for full PWA sync
  if (method === 'GET' && path === '/api/tasks/sync') {
    await materializeDueDuties(db, new Date().toISOString());
    const tasks = await db.listAllTasks();
    return json(tasks);
  }

  // GET /api/tasks/links — must come before the /:id wildcard match
  if (method === 'GET' && path === '/api/tasks/links') {
    const links = await db.listAllLinks();
    return json(links);
  }

  // POST /api/tasks/links — create a link
  if (method === 'POST' && path === '/api/tasks/links') {
    const body = await request.json<{ from_task_id: string; to_task_id: string; link_type: string }>();
    if (!body.from_task_id || !body.to_task_id || !body.link_type)
      return json({ error: 'from_task_id, to_task_id, link_type are required' }, 400);
    await db.linkTasks(body.from_task_id, body.to_task_id, body.link_type as TaskLink['link_type']);
    return json({ ok: true }, 201);
  }

  // DELETE /api/tasks/links — remove a link
  if (method === 'DELETE' && path === '/api/tasks/links') {
    const body = await request.json<{ from_task_id: string; to_task_id: string; link_type: string }>();
    if (!body.from_task_id || !body.to_task_id || !body.link_type)
      return json({ error: 'from_task_id, to_task_id, link_type are required' }, 400);
    await db.unlinkTasks(body.from_task_id, body.to_task_id, body.link_type as TaskLink['link_type']);
    return json({ ok: true });
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
    if (body.recurrence !== undefined && body.recurrence !== null) {
      return json({ error: 'Use /api/duties for recurring work; tasks.recurrence is legacy-only' }, 400);
    }
    let task;
    try {
      task = await db.addTask(body);
    } catch (error) {
      if (error instanceof TaskRecurrenceUnsupportedError) {
        return json({ error: error.message }, 400);
      }
      throw error;
    }
    return json(task, 201);
  }

  // PATCH /api/tasks/:id — update task
  if (method === 'PATCH' && singleMatch) {
    const body = await request.json<{
      title?: string;
      notes?: string;
      due_date?: string | null;
      recurrence?: string | null;
      kickoff_note?: string | null;
      session_log?: string | null;
      task_type?: 'action' | 'plan';
      project_id?: string | null;
      status?: 'pending';
      defer_until?: string | null;
      defer_kind?: 'none' | 'until' | 'someday';
      focused_until?: string | null;
    }>();
    let task;
    try {
      task = await db.updateTask(singleMatch[1], body);
    } catch (error) {
      if (error instanceof TaskRecurrenceUnsupportedError) {
        return json({ error: error.message }, 400);
      }
      throw error;
    }
    if (!task) return json({ error: 'Not found' }, 404);
    return json(task);
  }

  // DELETE /api/tasks/:id — hard delete
  if (method === 'DELETE' && singleMatch) {
    const deleted = await db.deleteTask(singleMatch[1]);
    if (!deleted) return json({ error: 'Not found' }, 404);
    return json({ ok: true });
  }

  // POST /api/tasks/:id/complete — mark task done; duty schedule advances independently.
  const completeMatch = path.match(/^\/api\/tasks\/([^/]+)\/complete$/);
  if (method === 'POST' && completeMatch) {
    await materializeDueDuties(db, new Date().toISOString());
    try {
      const result = await db.completeTask(completeMatch[1]);
      if (!result) return json({ error: 'Not found' }, 404);
      return json(result);
    } catch (error) {
      if (error instanceof LegacyRecurringTaskNeedsTimezoneError) {
        return json({ error: error.message }, 409);
      }
      throw error;
    }
  }

  // ── Duties ────────────────────────────────────────────────────────────────

  // GET /api/duties — list all duties (active and paused)
  if (method === 'GET' && path === '/api/duties') {
    await materializeDueDuties(db, new Date().toISOString());
    const duties = await db.listDuties();
    return json(duties);
  }

  // POST /api/duties — create a duty
  if (method === 'POST' && path === '/api/duties') {
    const body = await request.json<{
      title: string;
      notes?: string;
      kickoff_note?: string;
      task_type?: 'action' | 'plan';
      project_id?: string | null;
      recurrence: string;
      due_offset_days?: number;
      first_fire_date?: string;
      next_fire_at?: string;
    }>();
    if (!body.title || !body.recurrence) return json({ error: 'title and recurrence are required' }, 400);
    if (body.due_offset_days !== undefined && !isValidDutyOffsetDays(body.due_offset_days)) {
      return json({ error: 'due_offset_days must be an integer' }, 400);
    }
    const tz = await getUserTimezone(db);
    let nextFireAt = body.next_fire_at;
    if (nextFireAt !== undefined) {
      nextFireAt = normalizeIsoInstant(nextFireAt) ?? undefined;
      if (nextFireAt === undefined) {
        return json({ error: 'next_fire_at must be a valid ISO 8601 instant' }, 400);
      }
    } else {
      const firstFireDate = body.first_fire_date ?? todayInTz(tz);
      nextFireAt = firstFireDateToNextFireAt(firstFireDate, tz) ?? undefined;
      if (nextFireAt === undefined) {
        return json({ error: 'first_fire_date must be a valid YYYY-MM-DD date' }, 400);
      }
    }
    if (!isSupportedDutySchedule(body.recurrence, nextFireAt, tz)) {
      return json({ error: `Unsupported recurrence "${body.recurrence}"` }, 400);
    }
    const duty = await db.addDuty({
      title: body.title,
      notes: body.notes,
      kickoff_note: body.kickoff_note,
      task_type: body.task_type,
      project_id: body.project_id ?? undefined,
      recurrence: body.recurrence,
      due_offset_days: body.due_offset_days,
      next_fire_at: nextFireAt,
    });
    return json(duty, 201);
  }

  const dutyMatch = path.match(/^\/api\/duties\/([^/]+)$/);

  // GET /api/duties/:id
  if (method === 'GET' && dutyMatch) {
    const duty = await db.getDuty(dutyMatch[1]);
    if (!duty) return json({ error: 'Not found' }, 404);
    return json(duty);
  }

  // PATCH /api/duties/:id
  if (method === 'PATCH' && dutyMatch) {
    const body = await request.json<DutyUpdate & { first_fire_date?: string }>();
    const updates: DutyUpdate = { ...body };
    if (updates.due_offset_days !== undefined && !isValidDutyOffsetDays(updates.due_offset_days)) {
      return json({ error: 'due_offset_days must be an integer' }, 400);
    }
    let nextFireAt = updates.next_fire_at;
    if (nextFireAt !== undefined) {
      const normalizedNextFireAt = normalizeIsoInstant(nextFireAt);
      if (normalizedNextFireAt === null) {
        return json({ error: 'next_fire_at must be a valid ISO 8601 instant' }, 400);
      }
      nextFireAt = normalizedNextFireAt;
      updates.next_fire_at = nextFireAt;
    }
    if (body.first_fire_date !== undefined) {
      if (typeof body.first_fire_date !== 'string') {
        return json({ error: 'first_fire_date must be a valid YYYY-MM-DD date' }, 400);
      }
      const tz = await getUserTimezone(db);
      nextFireAt = firstFireDateToNextFireAt(body.first_fire_date, tz) ?? undefined;
      if (nextFireAt === undefined) {
        return json({ error: 'first_fire_date must be a valid YYYY-MM-DD date' }, 400);
      }
      updates.next_fire_at = nextFireAt;
      delete (updates as { first_fire_date?: string }).first_fire_date;
    }
    if (updates.recurrence !== undefined || nextFireAt !== undefined) {
      const existing = await db.getDuty(dutyMatch[1]);
      if (!existing) return json({ error: 'Not found' }, 404);
      const recurrence = updates.recurrence ?? existing.recurrence;
      const probeFireAt = nextFireAt ?? existing.next_fire_at;
      const tz = await getUserTimezone(db);
      if (!isSupportedDutySchedule(recurrence, probeFireAt, tz)) {
        return json({ error: `Unsupported recurrence "${recurrence}"` }, 400);
      }
    }
    const duty = await db.updateDuty(dutyMatch[1], updates);
    if (!duty) return json({ error: 'Not found' }, 404);
    return json(duty);
  }

  // DELETE /api/duties/:id
  if (method === 'DELETE' && dutyMatch) {
    const deleted = await db.deleteDuty(dutyMatch[1]);
    if (!deleted) return json({ error: 'Not found' }, 404);
    return json({ ok: true });
  }

  // GET /api/projects — list active projects
  if (method === 'GET' && path === '/api/projects') {
    const projects = await db.listProjects('active');
    return json(projects);
  }

  // GET /api/projects/sync — all projects including archived, for PWA sync
  if (method === 'GET' && path === '/api/projects/sync') {
    const projects = await db.listProjects();
    return json(projects);
  }

  // POST /api/projects — create project
  if (method === 'POST' && path === '/api/projects') {
    const body = await request.json<{ title: string; kickoff_note?: string; notes?: string }>();
    if (!body.title) return json({ error: 'title is required' }, 400);
    const project = await db.createProject(body);
    return json(project, 201);
  }

  // Project single-item routes
  const projectMatch = path.match(/^\/api\/projects\/([^/]+)$/);

  // GET /api/projects/:id
  if (method === 'GET' && projectMatch) {
    const project = await db.getProject(projectMatch[1]);
    if (!project) return json({ error: 'Not found' }, 404);
    return json(project);
  }

  // PATCH /api/projects/:id
  if (method === 'PATCH' && projectMatch) {
    const body = await request.json<ProjectUpdate>();
    const project = await db.updateProject(projectMatch[1], body);
    if (!project) return json({ error: 'Not found' }, 404);
    return json(project);
  }

  // DELETE /api/projects/:id
  if (method === 'DELETE' && projectMatch) {
    const deleted = await db.deleteProject(projectMatch[1]);
    if (!deleted) return json({ error: 'Not found' }, 404);
    return json({ ok: true });
  }

  // GET /api/action-log — recent operations, newest first
  if (method === 'GET' && path === '/api/action-log') {
    const entries = await db.getActionLog();
    return json(entries);
  }

  // PUT /api/preferences/timezone — set browser/user IANA timezone for duty scheduling
  if (method === 'PUT' && path === '/api/preferences/timezone') {
    const body = await request.json<{ timezone?: string }>();
    if (typeof body.timezone !== 'string' || !isValidTimezone(body.timezone)) {
      return json({ error: 'timezone must be a valid IANA timezone like "America/Los_Angeles"' }, 400);
    }
    await db.setPreference('timezone', body.timezone);
    return json({ updated: true, key: 'timezone', value: body.timezone });
  }

  // GET /api/export — full data dump as JSON
  if (method === 'GET' && path === '/api/export') {
    const includeLog = url.searchParams.get('include_log') === 'true';
    const payload = await db.exportAll(includeLog);
    const date = new Date().toISOString().split('T')[0];
    return new Response(JSON.stringify(payload), {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="alongside-export-${date}.json"`,
      },
    });
  }

  // POST /api/import — wipe and restore from export JSON
  if (method === 'POST' && path === '/api/import') {
    const dryRun = url.searchParams.get('dry_run') === 'true';
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }
    try {
      const result = await db.importAll(body as ExportPayload, dryRun);
      return json(result, dryRun ? 200 : 201);
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : 'Import failed' }, 400);
    }
  }

  return json({ error: 'Not found' }, 404);
}
