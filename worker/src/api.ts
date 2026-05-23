import { DB, DomainOperationError } from './db';
import type { InferOutput } from 'valibot';
import type { ValidationError } from '@shared/parse';
import { err, type Result } from '@shared/result';
import { appErrorMessage, appErrorStatus } from './domain/errors';
import { readJson } from './parse/request';
import { RestRouteSpecs } from './wire/rest';
import { parseRoute, parseWire, type RouteSpec } from './wire/route';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function domainErrorJson(error: DomainOperationError): Response {
  const body = error.appError.kind === 'validation'
    ? { error: appErrorMessage(error.appError), details: error.appError.errors }
    : { error: appErrorMessage(error.appError) };
  return json(body, appErrorStatus(error.appError));
}

function validationJson(errors: ValidationError[]): Response {
  return json({
    error: errors.map(error => error.message).join('; '),
    details: errors,
  }, 400);
}

async function parseJsonBody<TSpec extends RouteSpec<unknown, unknown, unknown>>(
  spec: TSpec,
  request: Request,
): Promise<Result<InferOutput<TSpec['body']>, ValidationError[]>> {
  const body = await readJson(request);
  if (!body.ok) return err(body.error);
  return parseWire(spec.body, body.value);
}

function hasReservedTaskSubroute(pathname: string): boolean {
  const parts = pathname.split('/');
  return parts[1] === 'api' && parts[2] === 'tasks' && (parts[3] === 'sync' || parts[3] === 'links');
}

function hasReservedProjectSubroute(pathname: string): boolean {
  const parts = pathname.split('/');
  return parts[1] === 'api' && parts[2] === 'projects' && parts[3] === 'sync';
}

export async function handleApiRequest(request: Request, url: URL, db: DB): Promise<Response> {
  // GET /api/tasks — list all non-done tasks
  const listTasksRoute = parseRoute(RestRouteSpecs.listTasks, request, url);
  if (!listTasksRoute.ok) return validationJson(listTasksRoute.error);
  if (listTasksRoute.value) {
    const tasks = await db.listTasks();
    return json(tasks);
  }

  // GET /api/tasks/sync — all tasks including done and deferred, for full PWA sync
  const syncTasksRoute = parseRoute(RestRouteSpecs.syncTasks, request, url);
  if (!syncTasksRoute.ok) return validationJson(syncTasksRoute.error);
  if (syncTasksRoute.value) {
    const tasks = await db.listAllTasks();
    return json(tasks);
  }

  // GET /api/tasks/links — must come before the /:id wildcard match
  const listTaskLinksRoute = parseRoute(RestRouteSpecs.listTaskLinks, request, url);
  if (!listTaskLinksRoute.ok) return validationJson(listTaskLinksRoute.error);
  if (listTaskLinksRoute.value) {
    const links = await db.listAllLinks();
    return json(links);
  }

  // POST /api/tasks/links — create a link
  const createTaskLinkRoute = parseRoute(RestRouteSpecs.createTaskLink, request, url);
  if (!createTaskLinkRoute.ok) return validationJson(createTaskLinkRoute.error);
  if (createTaskLinkRoute.value) {
    const body = await parseJsonBody(RestRouteSpecs.createTaskLink, request);
    if (!body.ok) return validationJson(body.error);
    try {
      await db.linkTasks(body.value.from_task_id, body.value.to_task_id, body.value.link_type);
      return json({ ok: true }, 201);
    } catch (error) {
      if (error instanceof DomainOperationError) return domainErrorJson(error);
      throw error;
    }
  }

  // DELETE /api/tasks/links — remove a link
  const deleteTaskLinkRoute = parseRoute(RestRouteSpecs.deleteTaskLink, request, url);
  if (!deleteTaskLinkRoute.ok) return validationJson(deleteTaskLinkRoute.error);
  if (deleteTaskLinkRoute.value) {
    const body = await parseJsonBody(RestRouteSpecs.deleteTaskLink, request);
    if (!body.ok) return validationJson(body.error);
    try {
      await db.unlinkTasks(body.value.from_task_id, body.value.to_task_id, body.value.link_type);
      return json({ ok: true });
    } catch (error) {
      if (error instanceof DomainOperationError) return domainErrorJson(error);
      throw error;
    }
  }

  if (hasReservedTaskSubroute(url.pathname)) {
    return json({ error: 'Not found' }, 404);
  }

  // GET /api/tasks/:id — get one task
  const getTaskRoute = parseRoute(RestRouteSpecs.getTask, request, url);
  if (!getTaskRoute.ok) return validationJson(getTaskRoute.error);
  if (getTaskRoute.value) {
    const task = await db.getTask(getTaskRoute.value.params.task_id);
    if (!task) return json({ error: 'Not found' }, 404);
    return json(task);
  }

  // POST /api/tasks — create task
  const createTaskRoute = parseRoute(RestRouteSpecs.createTask, request, url);
  if (!createTaskRoute.ok) return validationJson(createTaskRoute.error);
  if (createTaskRoute.value) {
    const body = await parseJsonBody(RestRouteSpecs.createTask, request);
    if (!body.ok) return validationJson(body.error);
    try {
      const task = await db.addTask(body.value);
      return json(task, 201);
    } catch (error) {
      if (error instanceof DomainOperationError) return domainErrorJson(error);
      throw error;
    }
  }

  // PATCH /api/tasks/:id — update task
  const updateTaskRoute = parseRoute(RestRouteSpecs.updateTask, request, url);
  if (!updateTaskRoute.ok) return validationJson(updateTaskRoute.error);
  if (updateTaskRoute.value) {
    const body = await parseJsonBody(RestRouteSpecs.updateTask, request);
    if (!body.ok) return validationJson(body.error);
    try {
      const task = await db.updateTask(updateTaskRoute.value.params.task_id, body.value);
      if (!task) return json({ error: 'Not found' }, 404);
      return json(task);
    } catch (error) {
      if (error instanceof DomainOperationError) return domainErrorJson(error);
      throw error;
    }
  }

  // DELETE /api/tasks/:id — hard delete
  const deleteTaskRoute = parseRoute(RestRouteSpecs.deleteTask, request, url);
  if (!deleteTaskRoute.ok) return validationJson(deleteTaskRoute.error);
  if (deleteTaskRoute.value) {
    const deleted = await db.deleteTask(deleteTaskRoute.value.params.task_id);
    if (!deleted) return json({ error: 'Not found' }, 404);
    return json({ ok: true });
  }

  // POST /api/tasks/:id/complete — complete + handle recurrence
  const completeTaskRoute = parseRoute(RestRouteSpecs.completeTask, request, url);
  if (!completeTaskRoute.ok) return validationJson(completeTaskRoute.error);
  if (completeTaskRoute.value) {
    try {
      const result = await db.completeTask(completeTaskRoute.value.params.task_id);
      if (!result) return json({ error: 'Not found' }, 404);
      return json(result);
    } catch (error) {
      if (error instanceof DomainOperationError) return domainErrorJson(error);
      throw error;
    }
  }

  // GET /api/projects — list active projects
  const listProjectsRoute = parseRoute(RestRouteSpecs.listProjects, request, url);
  if (!listProjectsRoute.ok) return validationJson(listProjectsRoute.error);
  if (listProjectsRoute.value) {
    const projects = await db.listProjects('active');
    return json(projects);
  }

  // GET /api/projects/sync — all projects including archived, for PWA sync
  const syncProjectsRoute = parseRoute(RestRouteSpecs.syncProjects, request, url);
  if (!syncProjectsRoute.ok) return validationJson(syncProjectsRoute.error);
  if (syncProjectsRoute.value) {
    const projects = await db.listProjects();
    return json(projects);
  }

  // POST /api/projects — create project
  const createProjectRoute = parseRoute(RestRouteSpecs.createProject, request, url);
  if (!createProjectRoute.ok) return validationJson(createProjectRoute.error);
  if (createProjectRoute.value) {
    const body = await parseJsonBody(RestRouteSpecs.createProject, request);
    if (!body.ok) return validationJson(body.error);
    try {
      const project = await db.createProject(body.value);
      return json(project, 201);
    } catch (error) {
      if (error instanceof DomainOperationError) return domainErrorJson(error);
      throw error;
    }
  }

  if (hasReservedProjectSubroute(url.pathname)) {
    return json({ error: 'Not found' }, 404);
  }

  // GET /api/projects/:id
  const getProjectRoute = parseRoute(RestRouteSpecs.getProject, request, url);
  if (!getProjectRoute.ok) return validationJson(getProjectRoute.error);
  if (getProjectRoute.value) {
    const project = await db.getProject(getProjectRoute.value.params.project_id);
    if (!project) return json({ error: 'Not found' }, 404);
    return json(project);
  }

  // PATCH /api/projects/:id
  const updateProjectRoute = parseRoute(RestRouteSpecs.updateProject, request, url);
  if (!updateProjectRoute.ok) return validationJson(updateProjectRoute.error);
  if (updateProjectRoute.value) {
    const body = await parseJsonBody(RestRouteSpecs.updateProject, request);
    if (!body.ok) return validationJson(body.error);
    try {
      const project = await db.updateProject(updateProjectRoute.value.params.project_id, body.value);
      if (!project) return json({ error: 'Not found' }, 404);
      return json(project);
    } catch (error) {
      if (error instanceof DomainOperationError) return domainErrorJson(error);
      throw error;
    }
  }

  // DELETE /api/projects/:id
  const deleteProjectRoute = parseRoute(RestRouteSpecs.deleteProject, request, url);
  if (!deleteProjectRoute.ok) return validationJson(deleteProjectRoute.error);
  if (deleteProjectRoute.value) {
    const deleted = await db.deleteProject(deleteProjectRoute.value.params.project_id);
    if (!deleted) return json({ error: 'Not found' }, 404);
    return json({ ok: true });
  }

  // GET /api/action-log — recent operations, newest first
  const getActionLogRoute = parseRoute(RestRouteSpecs.getActionLog, request, url);
  if (!getActionLogRoute.ok) return validationJson(getActionLogRoute.error);
  if (getActionLogRoute.value) {
    const entries = await db.getActionLog();
    return json(entries);
  }

  // GET /api/export — full data dump as JSON
  const exportRoute = parseRoute(RestRouteSpecs.exportAll, request, url);
  if (!exportRoute.ok) return validationJson(exportRoute.error);
  if (exportRoute.value) {
    const includeLog = exportRoute.value.query.include_log;
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
  const importRoute = parseRoute(RestRouteSpecs.importAll, request, url);
  if (!importRoute.ok) return validationJson(importRoute.error);
  if (importRoute.value) {
    const body = await readJson(request);
    if (!body.ok) return json({ error: 'Invalid JSON body' }, 400);
    try {
      const result = await db.importAll(body.value, importRoute.value.query.dry_run);
      return json(result, importRoute.value.query.dry_run ? 200 : 201);
    } catch (e) {
      if (e instanceof DomainOperationError) return domainErrorJson(e);
      return json({ error: e instanceof Error ? e.message : 'Import failed' }, 400);
    }
  }

  return json({ error: 'Not found' }, 404);
}
