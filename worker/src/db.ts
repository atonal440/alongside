import { nanoid } from 'nanoid';
import { drizzle } from 'drizzle-orm/d1';
import { eq, ne, inArray, lte, or, asc, desc, gt, and, sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import {
  tasks as tasksTable,
  projects as projectsTable,
  taskLinks as taskLinksTable,
  userPreferences as prefsTable,
  actionLog as actionLogTable,
} from '@shared/schema';
import type { Task, Project, TaskLink, ActionLog, TaskCreate, TaskUpdate, ProjectCreate, ProjectUpdate } from '@shared/types';
import { readinessScore } from '@shared/readiness';
import { unsafeBrand } from '@shared/brand';
import type { ActiveDeferState, Plan, PendingTaskDomain, TaskDomain } from './domain';
import type { IsoDateTime, MintedProjectId, MintedTaskId, TaskId, ValidationError } from './parse';
import { parseIsoDateTime, parseTaskId } from './parse';
import { appErrorMessage, validationErrorResult, type AppError } from './domain/errors';
import {
  clearDeferTaskPlan,
  completeTaskPlan,
  createProjectPlan,
  deferTaskPlan,
  focusTaskPlan,
  isReopenableTask,
  linkTasksPlan,
  pendingTaskFromRow,
  planImport,
  preferenceEntryFromParts,
  projectFromRow,
  reopenTaskPlan,
  taskLinkFromParts,
  taskFromRow,
  unlinkTasksPlan,
} from './domain';
import { applyPlan } from './storage';
import { parseImport } from './wire/importPayload';

export type { ActionLog as ActionLogEntry };

export interface ExportPayload {
  version: 1;
  exported_at: string;
  projects: Project[];
  tasks: Task[];
  links: TaskLink[];
  preferences: Record<string, string>;
  action_log?: ActionLog[];
}

export interface ImportResult {
  dry_run: boolean;
  would_delete?: { tasks: number; projects: number };
  would_insert?: { tasks: number; projects: number };
  inserted?: { projects: number; tasks: number; links: number; preferences: number; action_log: number };
}

const DEFAULT_PREFERENCES: Record<string, string> = {
  sort_by: 'readiness',
  planning_prompt: 'auto',
  kickoff_nudge: 'always',
  session_log: 'ask_at_end',
  interruption_style: 'proactive',
  urgency_visibility: 'hide',
};

export class DomainOperationError extends Error {
  constructor(readonly appError: AppError) {
    super(appErrorMessage(appError));
    this.name = 'DomainOperationError';
  }
}

function now(): IsoDateTime {
  const parsed = parseIsoDateTime(new Date().toISOString());
  if (!parsed.ok) {
    throw new DomainOperationError({
      kind: 'invariant_violation',
      message: 'System clock produced an invalid ISO timestamp.',
    });
  }
  return parsed.value;
}

function mintTaskId(): MintedTaskId {
  return unsafeBrand<string, 'MintedTaskId'>(`t_${nanoid(5)}`) as MintedTaskId;
}

function mintProjectId(): MintedProjectId {
  return unsafeBrand<string, 'MintedProjectId'>(`p_${nanoid(5)}`) as MintedProjectId;
}

function assertWritableTaskRow(task: Task): void {
  const parsed = taskFromRow(task);
  if (!parsed.ok) throw new DomainOperationError(validationErrorResult(parsed.error));
}

function assertWritableProjectRow(project: Project): void {
  const parsed = projectFromRow(project);
  if (!parsed.ok) throw new DomainOperationError(validationErrorResult(parsed.error));
}

function throwAppError(error: AppError): never {
  throw new DomainOperationError(error);
}

// Mirrors shared/readiness.ts isDeferred for SQL: a task is "not currently
// deferred" if its kind is 'none', or kind = 'until' with a non-future date.
// Invalid timed deferrals without defer_until are not treated as actionable.
function notDeferredCondition(nowIso: IsoDateTime) {
  return or(
    eq(tasksTable.defer_kind, 'none'),
    and(eq(tasksTable.defer_kind, 'until'), lte(tasksTable.defer_until, nowIso)),
  );
}

function withPath(path: string, errors: AppError): AppError {
  if (errors.kind !== 'validation') return errors;
  return validationErrorResult(errors.errors.map(error => ({
    ...error,
    path: [path, ...error.path],
  })));
}

function parseRequiredDateTime(path: string, input: string): IsoDateTime {
  const parsed = parseIsoDateTime(input);
  if (!parsed.ok) throwAppError(withPath(path, validationErrorResult(parsed.error)));
  return parsed.value;
}

function parseDeferInput(kind: 'until' | 'someday', until?: string | null): ActiveDeferState {
  if (kind === 'someday') {
    if (until !== undefined && until !== null) {
      throwAppError(validationErrorResult([{
        path: ['until'],
        code: 'invalid_state',
        message: 'until must be omitted when kind is someday.',
      }]));
    }
    return { kind: 'someday' };
  }

  if (!until) {
    throwAppError(validationErrorResult([{
      path: ['until'],
      code: 'required',
      message: 'until is required when kind is until.',
    }]));
  }

  return { kind: 'until', until: parseRequiredDateTime('until', until) };
}

function singleTaskUpdatePatchFromPlan(plan: Plan, plannerName: string, expectedTaskId?: string) {
  const [op] = plan.ops;
  if (plan.ops.length !== 1 || !op || op.kind !== 'task.update') {
    throwAppError({
      kind: 'invariant_violation',
      message: `${plannerName} produced an unexpected operation.`,
    });
  }
  if (expectedTaskId !== undefined && op.id !== expectedTaskId) {
    throwAppError({
      kind: 'invariant_violation',
      message: `${plannerName} produced an update for an unexpected task.`,
    });
  }
  return op.patch;
}

function parseTaskIds(inputs: string[]): TaskId[] {
  const ids: TaskId[] = [];
  const errors: ValidationError[] = [];
  for (const [index, input] of inputs.entries()) {
    const parsed = parseTaskId(input);
    if (parsed.ok) {
      ids.push(parsed.value);
    } else {
      errors.push(...parsed.error.map(error => ({
        ...error,
        path: ['task_ids', String(index), ...error.path],
      })));
    }
  }

  if (errors.length > 0) throwAppError(validationErrorResult(errors));
  return ids;
}


export class DB {
  private drizzle: DrizzleD1Database;

  constructor(private d1: D1Database) {
    this.drizzle = drizzle(d1);
  }

  private parseTaskDomain(row: Task): TaskDomain {
    const parsed = taskFromRow(row);
    if (!parsed.ok) throwAppError(validationErrorResult(parsed.error));
    return parsed.value;
  }

  private parsePendingTaskDomain(row: Task): PendingTaskDomain {
    const parsed = pendingTaskFromRow(row);
    if (!parsed.ok) throwAppError(parsed.error);
    return parsed.value;
  }

  private async applySingleTaskUpdate(original: Task, plan: Plan): Promise<Task> {
    singleTaskUpdatePatchFromPlan(plan, 'task transition planner', original.id);
    await this.applyPlanOrThrow(plan);

    const updated = await this.getTask(original.id);
    if (!updated) throwAppError({ kind: 'not_found', entity: 'task', id: original.id });
    return updated;
  }

  private async applyPlanOrThrow(plan: Plan): Promise<void> {
    const applied = await applyPlan(this.d1, plan);
    if (!applied.ok) throwAppError(applied.error);
  }

  // ── Tasks ──────────────────────────────────────────────────────────────────

  // Returns actionable tasks — excludes tasks that are currently deferred
  // (either kind = 'someday' or kind = 'until' with a future date).
  async listTasks(statuses: Task['status'][] = ['pending']): Promise<Task[]> {
    const ts = now();
    return this.drizzle
      .select()
      .from(tasksTable)
      .where(and(
        inArray(tasksTable.status, statuses),
        notDeferredCondition(ts),
      ))
      .orderBy(asc(tasksTable.due_date), asc(tasksTable.created_at));
  }

  // Returns all tasks including currently-deferred ones. Used for PWA full sync.
  async listAllTasks(statuses: Task['status'][] = ['pending', 'done']): Promise<Task[]> {
    return this.drizzle
      .select()
      .from(tasksTable)
      .where(inArray(tasksTable.status, statuses))
      .orderBy(asc(tasksTable.due_date), asc(tasksTable.created_at));
  }

  async getTask(id: string): Promise<Task | null> {
    const result = await this.drizzle
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.id, id))
      .limit(1);
    return result[0] ?? null;
  }

  async addTask(input: TaskCreate): Promise<Task> {
    const dueDate = input.due_date ?? null;
    const recurrence = input.recurrence ?? null;

    const timestamp = now();
    const task: Task = {
      id: mintTaskId(),
      title: input.title,
      notes: input.notes ?? null,
      status: 'pending',
      due_date: dueDate,
      recurrence,
      created_at: timestamp,
      updated_at: timestamp,
      defer_until: null,
      defer_kind: 'none',
      task_type: input.task_type ?? 'action',
      project_id: input.project_id ?? null,
      kickoff_note: input.kickoff_note ?? null,
      session_log: null,
      focused_until: null,
    };
    assertWritableTaskRow(task);

    await this.drizzle.insert(tasksTable).values(task);
    return task;
  }

  async completeTask(id: string): Promise<{ completed: Task; next?: Task } | null> {
    const task = await this.getTask(id);
    if (!task) return null;

    const timestamp = now();
    const domainTask = pendingTaskFromRow(task);
    if (!domainTask.ok) throwAppError(domainTask.error);

    const plan = completeTaskPlan(domainTask.value, {
      completedAt: timestamp,
      nextTaskId: domainTask.value.recurrence.kind === 'recurring' ? mintTaskId() : undefined,
    });
    if (!plan.ok) throwAppError(plan.error);

    await this.applyPlanOrThrow(plan.value);

    const completedOp = plan.value.ops.find(op => op.kind === 'task.update' && op.id === task.id);
    const completed = completedOp?.kind === 'task.update' ? { ...task, ...completedOp.patch } : null;
    const nextOp = plan.value.ops.find(op => op.kind === 'task.insert');
    const next = nextOp?.kind === 'task.insert' ? nextOp.row : undefined;

    if (!completed) {
      throwAppError({ kind: 'invariant_violation', message: 'completeTask plan did not update the completed task.' });
    }

    return next ? { completed, next } : { completed };
  }

  async reopenTask(id: string): Promise<Task | null> {
    const task = await this.getTask(id);
    if (!task) return null;

    const domainTask = this.parseTaskDomain(task);
    if (!isReopenableTask(domainTask)) {
      throwAppError({
        kind: 'invalid_transition',
        message: 'Only done or deferred pending tasks can be reopened.',
      });
    }

    const plan = reopenTaskPlan(domainTask, { updatedAt: now() });
    if (!plan.ok) throwAppError(plan.error);
    return this.applySingleTaskUpdate(task, plan.value);
  }

  async deferTask(id: string, kind: 'until' | 'someday', until?: string | null): Promise<Task | null> {
    const task = await this.getTask(id);
    if (!task) return null;

    const domainTask = this.parsePendingTaskDomain(task);
    const plan = deferTaskPlan(domainTask, {
      defer: parseDeferInput(kind, until),
      updatedAt: now(),
    });
    if (!plan.ok) throwAppError(plan.error);
    return this.applySingleTaskUpdate(task, plan.value);
  }

  async clearDeferTask(id: string): Promise<Task | null> {
    const task = await this.getTask(id);
    if (!task) return null;

    const domainTask = this.parsePendingTaskDomain(task);
    const plan = clearDeferTaskPlan(domainTask, { updatedAt: now() });
    if (!plan.ok) throwAppError(plan.error);
    return this.applySingleTaskUpdate(task, plan.value);
  }

  async focusTask(id: string, focusedUntilInput: string): Promise<Task | null> {
    const task = await this.getTask(id);
    if (!task) return null;

    const domainTask = this.parsePendingTaskDomain(task);
    const focusedUntil = parseRequiredDateTime('focused_until', focusedUntilInput);
    const timestamp = now();
    const plan = focusTaskPlan(domainTask, {
      focus: { kind: 'focused', until: focusedUntil },
      updatedAt: timestamp,
    });
    if (!plan.ok) throwAppError(plan.error);
    return this.applySingleTaskUpdate(task, plan.value);
  }

  async updateTask(id: string, updates: TaskUpdate): Promise<Task | null> {
    if (updates.status === 'done') {
      throwAppError({ kind: 'invalid_transition', message: 'Use completeTask() to mark a task done.' });
    }

    const patch: Partial<typeof tasksTable.$inferInsert> = {};
    if (updates.title !== undefined)        patch.title = updates.title;
    if (updates.notes !== undefined)        patch.notes = updates.notes;
    if (updates.due_date !== undefined)     patch.due_date = updates.due_date;
    if (updates.recurrence !== undefined)   patch.recurrence = updates.recurrence;
    if (updates.task_type !== undefined)    patch.task_type = updates.task_type;
    if (updates.project_id !== undefined)   patch.project_id = updates.project_id;
    if (updates.kickoff_note !== undefined) patch.kickoff_note = updates.kickoff_note;
    if (updates.session_log !== undefined)  patch.session_log = updates.session_log;
    if (updates.status !== undefined)       patch.status = updates.status;
    if (updates.defer_until !== undefined)  patch.defer_until = updates.defer_until;
    if (updates.defer_kind !== undefined)   patch.defer_kind = updates.defer_kind;
    if (updates.focused_until !== undefined) patch.focused_until = updates.focused_until;

    if (Object.keys(patch).length === 0) return this.getTask(id);

    const timestamp = now();
    patch.updated_at = timestamp;
    const existing = await this.getTask(id);
    if (!existing) return null;

    if (updates.defer_kind === 'until' || updates.defer_kind === 'someday') {
      const domainTask = this.parsePendingTaskDomain(existing);
      const plan = deferTaskPlan(domainTask, {
        defer: parseDeferInput(updates.defer_kind, updates.defer_until),
        updatedAt: timestamp,
      });
      if (!plan.ok) throwAppError(plan.error);
      Object.assign(patch, singleTaskUpdatePatchFromPlan(plan.value, 'deferTaskPlan', existing.id));
    }

    if (updates.focused_until !== undefined && updates.focused_until !== null) {
      const domainTask = this.parsePendingTaskDomain(existing);
      const focusedUntil = parseRequiredDateTime('focused_until', updates.focused_until);
      const plan = focusTaskPlan(domainTask, {
        focus: { kind: 'focused', until: focusedUntil },
        updatedAt: timestamp,
      });
      if (!plan.ok) throwAppError(plan.error);
      Object.assign(patch, singleTaskUpdatePatchFromPlan(plan.value, 'focusTaskPlan', existing.id));
    }

    assertWritableTaskRow({ ...existing, ...patch });

    await this.drizzle.update(tasksTable).set(patch).where(eq(tasksTable.id, id));
    return this.getTask(id);
  }

  async deleteTask(id: string): Promise<boolean> {
    const result = await this.d1
      .prepare('DELETE FROM tasks WHERE id = ?')
      .bind(id)
      .run();
    return result.meta.changes > 0;
  }

  // Returns tasks that are not blocked by any incomplete task, sorted by readiness score.
  async listReadyTasks(projectId?: string): Promise<Task[]> {
    const ts = now();
    const conditions = [
      eq(tasksTable.status, 'pending'),
      notDeferredCondition(ts),
      // Correlated NOT EXISTS — kept in raw SQL; Drizzle has no first-class support for it
      sql`NOT EXISTS (
        SELECT 1 FROM task_links tl
        JOIN tasks blocker ON tl.from_task_id = blocker.id
        WHERE tl.to_task_id = ${tasksTable.id}
          AND tl.link_type = 'blocks'
          AND blocker.status != 'done'
      )`,
    ];
    if (projectId) conditions.push(eq(tasksTable.project_id, projectId));

    const results = await this.drizzle
      .select()
      .from(tasksTable)
      .where(and(...conditions));

    return results.sort((a, b) => readinessScore(b, ts) - readinessScore(a, ts));
  }

  // Returns tasks whose focused_until is still in the future.
  async listFocusedTasks(): Promise<Task[]> {
    const ts = now();
    return this.drizzle
      .select()
      .from(tasksTable)
      .where(and(
        gt(tasksTable.focused_until, ts),
        ne(tasksTable.status, 'done'),
        notDeferredCondition(ts),
      ))
      .orderBy(asc(tasksTable.focused_until));
  }

  // ── Projects ───────────────────────────────────────────────────────────────

  async createProject(input: ProjectCreate, taskIds: string[] = []): Promise<Project> {
    const timestamp = now();
    const project: Project = {
      id: mintProjectId(),
      title: input.title,
      notes: input.notes ?? null,
      kickoff_note: input.kickoff_note ?? null,
      status: 'active',
      created_at: timestamp,
      updated_at: timestamp,
    };
    assertWritableProjectRow(project);

    const plan = createProjectPlan(project, parseTaskIds(taskIds), timestamp);
    if (!plan.ok) throwAppError(plan.error);
    await this.applyPlanOrThrow(plan.value);
    return project;
  }

  async getProject(id: string): Promise<Project | null> {
    const result = await this.drizzle
      .select()
      .from(projectsTable)
      .where(eq(projectsTable.id, id))
      .limit(1);
    return result[0] ?? null;
  }

  async listProjects(status?: Project['status']): Promise<Project[]> {
    if (status) {
      return this.drizzle
        .select()
        .from(projectsTable)
        .where(eq(projectsTable.status, status))
        .orderBy(asc(projectsTable.created_at));
    }
    return this.drizzle
      .select()
      .from(projectsTable)
      .orderBy(asc(projectsTable.created_at));
  }

  async updateProject(id: string, updates: ProjectUpdate): Promise<Project | null> {
    const patch: Partial<typeof projectsTable.$inferInsert> = {};
    if (updates.title !== undefined)        patch.title = updates.title;
    if (updates.notes !== undefined)        patch.notes = updates.notes;
    if (updates.kickoff_note !== undefined) patch.kickoff_note = updates.kickoff_note;
    if (updates.status !== undefined)       patch.status = updates.status;

    if (Object.keys(patch).length === 0) return this.getProject(id);

    patch.updated_at = now();
    const existing = await this.getProject(id);
    if (!existing) return null;
    assertWritableProjectRow({ ...existing, ...patch });

    await this.drizzle.update(projectsTable).set(patch).where(eq(projectsTable.id, id));
    return this.getProject(id);
  }

  async deleteProject(id: string): Promise<boolean> {
    await this.drizzle
      .update(tasksTable)
      .set({ project_id: null, updated_at: now() })
      .where(eq(tasksTable.project_id, id));
    const result = await this.d1
      .prepare('DELETE FROM projects WHERE id = ?')
      .bind(id)
      .run();
    return result.meta.changes > 0;
  }

  // ── Task Links ─────────────────────────────────────────────────────────────

  async linkTasks(fromTaskId: string, toTaskId: string, linkType: TaskLink['link_type']): Promise<void> {
    const link = taskLinkFromParts(fromTaskId, toTaskId, linkType);
    if (!link.ok) throwAppError(validationErrorResult(link.error));

    const plan = linkTasksPlan(link.value);
    if (!plan.ok) throwAppError(plan.error);
    await this.applyPlanOrThrow(plan.value);
  }

  async unlinkTasks(fromTaskId: string, toTaskId: string, linkType: TaskLink['link_type']): Promise<void> {
    const link = taskLinkFromParts(fromTaskId, toTaskId, linkType);
    if (!link.ok) throwAppError(validationErrorResult(link.error));

    const plan = unlinkTasksPlan(link.value);
    if (!plan.ok) throwAppError(plan.error);
    await this.applyPlanOrThrow(plan.value);
  }

  async getTaskLinks(taskId: string): Promise<TaskLink[]> {
    return this.d1
      .prepare('SELECT * FROM task_links WHERE from_task_id = ? OR to_task_id = ?')
      .bind(taskId, taskId)
      .all<TaskLink>()
      .then(r => r.results);
  }

  async listAllLinks(): Promise<TaskLink[]> {
    return this.drizzle.select().from(taskLinksTable);
  }

  // ── Preferences ───────────────────────────────────────────────────────────

  async getPreference(key: string): Promise<string | null> {
    const result = await this.drizzle
      .select({ value: prefsTable.value })
      .from(prefsTable)
      .where(eq(prefsTable.key, key))
      .limit(1);
    return result[0]?.value ?? null;
  }

  async setPreference(key: string, value: string): Promise<void> {
    const parsedPreference = preferenceEntryFromParts(key, value);
    if (!parsedPreference.ok) throwAppError(validationErrorResult(parsedPreference.error));

    await this.d1
      .prepare('INSERT OR REPLACE INTO user_preferences (key, value) VALUES (?, ?)')
      .bind(key, value)
      .run();
  }

  async getAllPreferences(): Promise<Record<string, string>> {
    const rows = await this.drizzle.select().from(prefsTable);
    const prefs: Record<string, string> = { ...DEFAULT_PREFERENCES };
    for (const row of rows) {
      prefs[row.key] = row.value;
    }
    return prefs;
  }

  // ── Action Log ─────────────────────────────────────────────────────────────

  async logAction(entry: { tool_name: string; task_id?: string; title: string; detail?: string }): Promise<ActionLog> {
    const created_at = now();
    // Raw D1 used here to access last_row_id for the returned id
    const result = await this.d1
      .prepare('INSERT INTO action_log (tool_name, task_id, title, detail, created_at) VALUES (?, ?, ?, ?, ?)')
      .bind(entry.tool_name, entry.task_id ?? null, entry.title, entry.detail ?? null, created_at)
      .run();
    return {
      id: result.meta.last_row_id as number,
      tool_name: entry.tool_name,
      task_id: entry.task_id ?? null,
      title: entry.title,
      detail: entry.detail ?? null,
      created_at,
    };
  }

  async getActionLog(limit = 50): Promise<ActionLog[]> {
    return this.drizzle
      .select()
      .from(actionLogTable)
      .orderBy(desc(actionLogTable.id))
      .limit(limit);
  }

  // Seed missing default preferences (called by start_session)
  async seedDefaultPreferences(): Promise<void> {
    for (const [key, value] of Object.entries(DEFAULT_PREFERENCES)) {
      await this.d1
        .prepare('INSERT OR IGNORE INTO user_preferences (key, value) VALUES (?, ?)')
        .bind(key, value)
        .run();
    }
  }

  // ── Archive / Restore ──────────────────────────────────────────────────────

  async exportAll(includeLog = false): Promise<ExportPayload> {
    const [taskRows, projectRows, linkRows, prefRows, logRows] = await Promise.all([
      this.drizzle.select().from(tasksTable),
      this.drizzle.select().from(projectsTable),
      this.drizzle.select().from(taskLinksTable),
      this.drizzle.select().from(prefsTable),
      includeLog
        ? this.drizzle.select().from(actionLogTable).orderBy(asc(actionLogTable.id))
        : Promise.resolve([] as ActionLog[]),
    ]);

    const payload: ExportPayload = {
      version: 1,
      exported_at: now(),
      projects: projectRows,
      tasks: taskRows,
      links: linkRows,
      preferences: Object.fromEntries(prefRows.map(p => [p.key, p.value])),
    };
    if (includeLog) payload.action_log = logRows;
    return payload;
  }

  async importAll(payload: unknown, dryRun = false): Promise<ImportResult> {
    const parsedPayload = parseImport(payload);
    if (!parsedPayload.ok) throwAppError(validationErrorResult(parsedPayload.error));

    const importPlan = planImport(parsedPayload.value);
    if (!importPlan.ok) throwAppError(importPlan.error);

    if (dryRun) {
      const [taskCount, projectCount] = await Promise.all([
        this.drizzle.select({ n: sql<number>`count(*)` }).from(tasksTable),
        this.drizzle.select({ n: sql<number>`count(*)` }).from(projectsTable),
      ]);
      return {
        dry_run: true,
        would_delete: { tasks: taskCount[0].n, projects: projectCount[0].n },
        would_insert: { tasks: parsedPayload.value.tasks.length, projects: parsedPayload.value.projects.length },
      };
    }

    await this.applyPlanOrThrow(importPlan.value);

    const logEntries = parsedPayload.value.action_log ?? [];

    return {
      dry_run: false,
      inserted: {
        projects: parsedPayload.value.projects.length,
        tasks: parsedPayload.value.tasks.length,
        links: parsedPayload.value.links.length,
        preferences: Object.keys(parsedPayload.value.preferences).length,
        action_log: logEntries.length,
      },
    };
  }
}
