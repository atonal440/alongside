import type { Revision } from '@shared/parse';
import { readWorkspaceSnapshot, readWorkspaceDelta } from './storage/sync';
import type { WorkspaceDeltaInput } from '@shared/wire/sync';
import { workspaceExport } from './domain/workspaceExport';
import { planWorkspaceRestore } from './domain/workspaceRestore';
import { parseWorkspaceRestoreResult, restoreCounts, type RestoreCounts, type WorkspaceRestoreInput, type WorkspaceRestoreResult } from '@shared/wire/workspaceRestore';
import { planBatchCommand, type CommandReader } from './domain/batchCommands';
import { readDeleteContext } from './storage/deletion';
import { planDeleteCommand } from './domain/deleteCommands';
import { readLinkContext } from './storage/link';
import { linkCommandKey, planLinkCommand } from './domain/linkCommands';
import type { LinkKey, LinkSnapshot } from '@shared/wire/versions';
import { checkPlanCapacity, readEntityVersion } from './storage/apply';
import type { EntityKey, EntityVersionResponse, EntityReadKey, EntitySnapshot } from '@shared/wire/versions';
import { readEntitySnapshot } from './storage/entity';
import { parsePlanningSettings, type PlanningSettings } from '@shared/wire/planning';
import type { LegacyDueRow } from './domain/temporalFoundation';
import { parseStoredResult, type ReceiptTool, type StoredResult } from '@shared/wire/receipts';
import { StoredReceiptSchema, type CommandEnvelope, type ChangesResult, type ChangesPreview } from '@shared/wire/commands';
import { parseSchema, parseEventInstant, type EventInstant, type CommandId } from '@shared/parse';
import { invalidInput } from './domain/temporalFoundation';
import { CommandError, commandHash, payloadConflict, planSettingsCommand, planPreferenceCommand, planCreateCommand, creationConflict, planContentCommand, entityCommandConflict, planStateCommand, commandEntityKey, planCompleteCommand, planTaskProjectCommand, planTaskParentCommand, MAX_TASK_DEPTH, revisionConflict, preferenceConflict } from './domain/commands';
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
import { isAvailable, readinessScore } from '@shared/readiness';
import { unsafeBrand } from '@shared/brand';
import type { ActiveDeferState, Plan, PendingTaskDomain, TaskDomain } from './domain';
import type { Op, PreCheck } from './domain/Op';
import { commandLogDrafts, linkEndpoints, titlesFrom } from './domain/commandLog';
import type { PreferenceState } from './domain/commands';
import type { IsoDateTime, MintedProjectId, MintedTaskId, TaskId, ValidationError } from './parse';
import { parseDueDateParts, parseIsoDateTime, parseIsoDateTimeMinute, parseTaskId } from './parse';
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

// Truncates to minute resolution on write (Decision 4) — used for
// focused_until/defer's `until`, which are always already-full instants.
function parseRequiredDateTime(path: string, input: string): IsoDateTime {
  const parsed = parseIsoDateTimeMinute(input);
  if (!parsed.ok) throwAppError(withPath(path, validationErrorResult(parsed.error)));
  return parsed.value;
}

// due_date's write-time resolver: the single choke point both REST and MCP
// funnel through (MCP passes due_date straight through with no upstream
// validation; REST validates shape only, via DueDateStringSchema, so this is
// still the first real parse). due_all_day is used as-is when the caller
// supplies it explicitly (the PWA does this to preserve an existing value
// across an edit that doesn't touch the due date); otherwise it's derived
// from whether due_date was written as a bare date or a full instant — see
// shared/parse/primitives.ts parseDueDateParts.
function resolveDueDate(
  dueDateInput: string | null | undefined,
  allDayInput: boolean | null | undefined,
): { due_date: IsoDateTime | null; due_all_day: boolean | null } {
  if (dueDateInput === null || dueDateInput === undefined) {
    return { due_date: null, due_all_day: null };
  }
  const parsed = parseDueDateParts(dueDateInput);
  if (!parsed.ok) throwAppError(withPath('due_date', validationErrorResult(parsed.error)));
  return {
    due_date: parsed.value.due_date,
    due_all_day: allDayInput ?? parsed.value.due_all_day,
  };
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


export interface ToolLogDraft { tool_name: string; task_id: string | null; title: string; detail: string | null }

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
    const resolvedDueDate = resolveDueDate(input.due_date, input.due_all_day);
    const recurrence = input.recurrence ?? null;

    const timestamp = now();
    const task: Task = {
      id: mintTaskId(),
      title: input.title,
      notes: input.notes ?? null,
      status: 'pending',
      due_date: resolvedDueDate.due_date,
      due_all_day: resolvedDueDate.due_all_day,
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
      duty_id: null,
      occurrence_at: null,
      available_from: null,
      deadline: null,
      parent_id: null,
      position: null,
    };
    assertWritableTaskRow(task);

    await this.drizzle.insert(tasksTable).values(task);
    return task;
  }

  async completeTask(id: string): Promise<{ completed: Task; next?: Task } | null> {
    const task = await this.getTask(id);
    if (!task) return null;

    const open = (await this.readChildren([id])).filter(child => child.status === 'pending').length;
    if (open > 0) throwAppError({ kind: 'invalid_transition', message: `Complete the ${open} open subtask${open === 1 ? '' : 's'} first.` });
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
    if (updates.due_date !== undefined) {
      const resolved = resolveDueDate(updates.due_date, updates.due_all_day);
      patch.due_date = resolved.due_date;
      patch.due_all_day = resolved.due_all_day;
    } else if (updates.due_all_day !== undefined) {
      // due_all_day-only update: no due_date rewrite, just correcting the
      // all-day/timed classification on an existing due_date (e.g. fixing an
      // ambiguous noon-UTC row the migration backfill left NULL).
      patch.due_all_day = updates.due_all_day;
    }
    if (updates.recurrence !== undefined)   patch.recurrence = updates.recurrence;
    if (updates.task_type !== undefined)    patch.task_type = updates.task_type;
    if (updates.project_id !== undefined)   patch.project_id = updates.project_id;
    if (updates.kickoff_note !== undefined) patch.kickoff_note = updates.kickoff_note;
    if (updates.session_log !== undefined)  patch.session_log = updates.session_log;
    if (updates.status !== undefined)       patch.status = updates.status;
    // Parsed here (not just via parseDeferInput below) because that only
    // runs when defer_kind is also present in this same PATCH — a
    // standalone defer_until update on a task that's already defer_kind:
    // 'until' would otherwise skip the minute-resolution parser entirely
    // and persist raw seconds/millis, violating Decision 4.
    if (updates.defer_until !== undefined) {
      patch.defer_until = updates.defer_until === null
        ? null
        : parseRequiredDateTime('defer_until', updates.defer_until);
    }
    if (updates.defer_kind !== undefined)   patch.defer_kind = updates.defer_kind;
    if (updates.focused_until !== undefined) patch.focused_until = updates.focused_until;

    if (Object.keys(patch).length === 0) return this.getTask(id);

    const timestamp = now();
    patch.updated_at = timestamp;
    const existing = await this.getTask(id);
    if (!existing) return null;
    if (updates.project_id !== undefined && updates.project_id !== existing.project_id
      && (existing.parent_id !== null || (await this.readChildren([id])).length > 0)) {
      throwAppError({ kind: 'invalid_transition', message: 'A task in a hierarchy cannot change project on its own; detach it from its parent and subtasks first.' });
    }

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
    if ((await this.readChildren([id])).length > 0) throwAppError({ kind: 'invalid_transition', message: 'This task has subtasks; delete or detach them first.' });
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

    return results.filter(task => isAvailable(task, ts)).sort((a, b) => readinessScore(b, ts) - readinessScore(a, ts) || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
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

  // Typed version/configuration reads preserve the legacy task row contract.
  async getWorkspaceSnapshot() { return readWorkspaceSnapshot(this.d1); }
  async getWorkspaceDelta(input: WorkspaceDeltaInput) { return readWorkspaceDelta(this.d1, input); }
  async exportWorkspace() { return workspaceExport(await this.getWorkspaceSnapshot(), new Date().toISOString()); }

  /** One statement: cursor, planning revision and live family counts agree. */
  private async readRestoreBaseline(): Promise<{ cursor: { epoch: number; sequence: number }; planningRevision: number; counts: RestoreCounts }> {
    const row = await this.d1.prepare(`SELECT m.epoch, m.watermark, (SELECT COALESCE(MAX(revision),0) FROM planning_settings) AS planning_revision,
      (SELECT COUNT(*) FROM tasks) AS tasks, (SELECT COUNT(*) FROM projects) AS projects, (SELECT COUNT(*) FROM task_links) AS links,
      (SELECT COUNT(*) FROM duties) AS duties, (SELECT COUNT(*) FROM user_preferences) AS preferences,
      (SELECT COUNT(*) FROM planning_settings) AS planning_settings, (SELECT COUNT(*) FROM action_log) AS action_log
      FROM sync_metadata m WHERE m.id=1`).first<Record<string, number>>();
    if (!row) throw new Error('Sync metadata is missing.');
    return { cursor: { epoch: row.epoch!, sequence: row.watermark! }, planningRevision: row.planning_revision!,
      counts: { tasks: row.tasks!, projects: row.projects!, links: row.links!, duties: row.duties!, preferences: row.preferences!,
        planning_settings: row.planning_settings! as 0 | 1, action_log: row.action_log! } };
  }

  /**
   * Replace the workspace from a version 2 export in one atomic batch. Preflight
   * runs the identical validation/capacity/cursor checks and writes nothing.
   */
  async restoreWorkspace(input: WorkspaceRestoreInput): Promise<WorkspaceRestoreResult> {
    const baseline = await this.readRestoreBaseline();
    if (baseline.cursor.epoch !== input.expectedCursor.epoch || baseline.cursor.sequence !== input.expectedCursor.sequence) throw this.restoreCursorConflict(baseline.cursor);
    const clock = parseEventInstant(new Date().toISOString());
    if (!clock.ok) throw new Error('Invalid server clock.');
    const plan = planWorkspaceRestore(input, baseline.planningRevision, clock.value);
    const tooLarge = (error: AppError): CommandError | null => error.kind !== 'capacity_exceeded' ? null
      : new CommandError({ code: 'capacity_exceeded', path: ['document'], message: `Atomic restore requires ${error.requiredStatements} SQL statements; the limit is 100.`,
        retryable: false, requiredStatements: error.requiredStatements, limit: 100, recoveryHint: 'Restore is one atomic replacement and is never split into independent wipes. Reduce the document or wait for staged restore.' }, 413);
    if (!plan.ok) {
      // Command routes map CommandError only; keep semantic problems a 400 with paths.
      if (plan.error.kind === 'validation') throw new CommandError(invalidInput(plan.error.errors), 400);
      throw tooLarge(plan.error) ?? new DomainOperationError(plan.error);
    }
    const capacity = checkPlanCapacity(this.d1, plan.value);
    if (!capacity.ok) throw tooLarge(capacity.error) ?? new DomainOperationError(capacity.error);
    const base = { contractVersion: 2 as const, mode: input.mode, previousCursor: baseline.cursor, replaces: baseline.counts, restores: restoreCounts(input.document),
      notRestored: { command_audit: input.document.command_audit.length }, requiredStatements: capacity.value.requiredStatements, limit: 100 as const, nextEpoch: baseline.cursor.epoch + 1 };
    let resultingCursor = null;
    if (input.mode === 'apply') {
      const applied = await applyPlan(this.d1, plan.value);
      if (!applied.ok) {
        const current = await this.readRestoreBaseline();
        // The epoch only advances in a restore batch. If it moved, this very batch may have committed
        // before its response was lost, so never claim nothing changed.
        if (current.cursor.epoch !== baseline.cursor.epoch) throw new CommandError({ code: 'restore_outcome_unknown', path: ['expectedCursor'], retryable: false,
          message: `The sync epoch is now ${current.cursor.epoch}; a restore committed, possibly this one, and its response was not delivered.`,
          recoveryHint: 'Read get_workspace_snapshot and compare with the intended document before deciding whether to restore again.' }, 409);
        if (applied.error.kind === 'conflict' || current.cursor.sequence !== baseline.cursor.sequence) throw this.restoreCursorConflict(current.cursor);
        throw new CommandError({ code: 'storage_unavailable', path: [], message: 'The restore could not be committed. Nothing was changed.', retryable: true,
          recoveryHint: 'Run preflight again with the current cursor, then retry apply.' }, 503);
      }
      // Resume point in the new epoch: the pre-restore watermark. Every restore event has a higher
      // sequence, and a watermark is never below the retention floor, so replaying from here neither
      // skips a later writer nor reads as expired history. A fresh bootstrap is cheaper.
      resultingCursor = { epoch: baseline.cursor.epoch + 1, sequence: baseline.cursor.sequence };
    }
    const result = parseWorkspaceRestoreResult({ ...base, applied: input.mode === 'apply', resultingCursor });
    if (!result.ok) throw new Error('Restore result failed validation.');
    return result.value;
  }

  private restoreCursorConflict(current: { epoch: number; sequence: number }): CommandError {
    return new CommandError({ code: 'restore_cursor_conflict', path: ['expectedCursor'], retryable: false,
      message: `The workspace changed after the supplied cursor; it is now at epoch ${current.epoch}, sequence ${current.sequence}. This request wrote nothing, but if you are retrying an apply, your earlier restore may already have committed.`,
      recoveryHint: 'Read a current snapshot. An epoch above your expectedCursor.epoch means a restore committed, possibly yours; otherwise export again, review the new state, and rerun preflight with the current cursor before applying.' }, 409);
  }

  async getEntitySnapshot(key: EntityReadKey): Promise<EntitySnapshot> {
    return readEntitySnapshot(this.d1, key);
  }

  /** Direct subtasks of a task, from the same database the planner will guard. */
  async readChildren(ids: string[]): Promise<{ id: string; status: string; parent_id: string }[]> {
    const found: { id: string; status: string; parent_id: string }[] = [];
    for (let at = 0; at < ids.length; at += 80) {
      const chunk = ids.slice(at, at + 80);
      const { results } = await this.d1.prepare(`SELECT id, status, parent_id FROM tasks WHERE parent_id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all<{ id: string; status: string; parent_id: string }>();
      found.push(...results);
    }
    return found;
  }

  async getLinkSnapshot(key: LinkKey): Promise<LinkSnapshot> { return (await readLinkContext(this.d1, key)).current; }

  private async planCommand(input: CommandEnvelope, hash: string, clock: EventInstant, reader:CommandReader={entity:key=>this.getEntitySnapshot(key),link:key=>readLinkContext(this.d1,key),deletion:key=>readDeleteContext(this.d1,key),children:id=>this.readChildren(id)}): Promise<{ plan: Plan; result: ChangesResult }> {
    if(input.commands.length>1)return planBatchCommand(input,reader,(atom,virtual)=>this.planCommand(atom,hash,clock,virtual),(changes,expected)=>this.validateBatchGraph(changes,expected),hash,clock);
    const command = input.commands[0]!;
    if (command.kind === 'task.delete' || command.kind === 'project.delete') return planDeleteCommand(input, await reader.deletion(commandEntityKey(command)), command.kind === 'task.delete' ? await reader.children([command.id]) : [], hash, clock);
    if (command.kind === 'link.add' || command.kind === 'link.remove') return planLinkCommand(input, await reader.link(linkCommandKey(command)), hash, clock);
    if (command.kind === 'planning.set') return planSettingsCommand(input, await this.getPlanningSettings(), hash, clock);
    if (command.kind === 'preference.set') return planPreferenceCommand(input, await this.readPreferenceState(command.key), hash, clock);
    if (command.kind === 'task.project.set') {
      const current = await reader.entity({ entity: 'task', id: command.id });
      const project = command.project === null ? null : await reader.entity({ entity: 'project', id: command.project.id });
      return planTaskProjectCommand(input, current, project, await reader.children([command.id]), hash, clock);
    }
    if (command.kind === 'task.parent.set') {
      const current = await reader.entity({ entity: 'task', id: command.id });
      const parent = command.parent === null ? null : await reader.entity({ entity: 'task', id: command.parent.id });
      // Walk up from the new parent far enough to see a loop or an over-deep chain.
      const ancestors: EntitySnapshot[] = [];
      const parentOf = (snapshot: EntitySnapshot | null) => snapshot?.entity === 'task' ? snapshot.row?.parent_id ?? null : null;
      let next = parentOf(parent);
      while (next !== null && ancestors.length < MAX_TASK_DEPTH) {
        const above = await reader.entity({ entity: 'task', id: next as never });
        ancestors.push(above);
        if (above.id === command.id) break;
        next = parentOf(above);
      }
      // Levels below the moved task, so a deep subtree cannot be hung under a deep parent.
      let height = 0;
      if (parent !== null) {
        let level = [command.id as string];
        while (level.length > 0 && height <= MAX_TASK_DEPTH) {
          const below = (await reader.children(level)).map(child => child.id);
          if (below.length > 0) height++;
          level = below;
        }
      }
      return planTaskParentCommand(input, current, parent, ancestors, height, hash, clock);
    }
    if (command.kind === 'task.complete') {
      const current = await reader.entity({ entity: 'task', id: command.id });
      const successor = command.successor === null ? null : await reader.entity({ entity: 'task', id: command.successor.id });
      return planCompleteCommand(input, current, successor, await reader.children([command.id]), hash, clock);
    }
    if (command.kind !== 'task.create' && command.kind !== 'project.create') {
      const snapshot = await reader.entity(commandEntityKey(command));
      return command.kind === 'task.content.set' || command.kind === 'project.content.set'
        ? planContentCommand(input, snapshot, hash, clock) : planStateCommand(input, snapshot, hash, clock);
    }
    const current = await reader.entity(command.kind === 'task.create' ? { entity: 'task', id: command.id } : { entity: 'project', id: command.id });
    const project = command.kind === 'task.create' && command.values.project !== null
      ? await reader.entity({ entity: 'project', id: command.values.project.id }) : null;
    if (project !== null && project.structuralRevision !== current.structuralRevision) throw new CommandError({
      code: 'structural_conflict', path: ['commands', '0', 'expectedStructuralRevision'], message: 'Workspace changed between entity reads.', retryable: false,
      currentEntity: project, expectedStructuralRevision: command.expectedStructuralRevision, recoveryHint: 'Retain the proposed creation and preview again with a fresh command ID after rebasing.',
    });
    return planCreateCommand(input, current, project, hash, clock);
  }

  private async validateBatchGraph(changes:ChangesResult['changes'],expected:Revision):Promise<void> {
    const row=await this.d1.prepare(`WITH RECURSIVE input AS (SELECT value FROM json_each(?)),
      additions AS (SELECT json_extract(value,'$.after.row.from_task_id') AS from_id,json_extract(value,'$.after.row.to_task_id') AS to_id FROM input WHERE json_extract(value,'$.entity')='link' AND json_extract(value,'$.after.row.link_type')='blocks'),
      edges AS (SELECT from_task_id AS from_id,to_task_id AS to_id FROM task_links WHERE link_type='blocks' AND NOT EXISTS(SELECT 1 FROM input WHERE json_extract(value,'$.entity')='link' AND json_extract(value,'$.after.deleted')=1 AND json_extract(value,'$.id')=json_array(from_task_id,to_task_id,link_type)) UNION SELECT from_id,to_id FROM additions),
      reachable(origin,id) AS (SELECT from_id,to_id FROM additions UNION SELECT r.origin,e.to_id FROM reachable r JOIN edges e ON e.from_id=r.id)
      SELECT structural_revision,EXISTS(SELECT 1 FROM reachable WHERE origin=id) AS has_cycle FROM workspace_versions WHERE id=1`).bind(JSON.stringify(changes)).first<{structural_revision:number;has_cycle:number}>();
    if(!row)throw new Error('Workspace singleton is missing.');
    if(row.structural_revision!==expected)throw new CommandError({code:'structural_conflict',path:['expectedStructuralRevision'],message:'Workspace changed while validating the final graph.',retryable:false,expectedStructuralRevision:expected,recoveryHint:'Retain the entire batch and explicitly rebase after inspecting current state.'});
    if(row.has_cycle===1)throw new CommandError({code:'graph_cycle',path:['commands'],message:'The final blocks graph contains a new cycle.',retryable:false,recoveryHint:'Retain intent and revise the proposed dependency graph with a new command ID.'});
    if(row.has_cycle!==0)throw new Error('Invalid final graph result.');
  }

  async getEntityVersion(key: EntityKey): Promise<EntityVersionResponse> {
    return readEntityVersion(this.d1, key);
  }

  /** A preference's value and sync revision. `nextRevision` is what a write will record (past any tombstone). */
  async readPreferenceState(key: string): Promise<PreferenceState> {
    const row = await this.d1.prepare(`SELECT p.value AS value, a.revision AS revision, a.deleted_at AS deleted_at
      FROM (SELECT ? AS key) k LEFT JOIN user_preferences p ON p.key=k.key
      LEFT JOIN sync_aux_versions a ON a.entity='preference' AND a.entity_key=k.key`).bind(key)
      .first<{ value: string | null; revision: number | null; deleted_at: string | null }>();
    const live = row?.value !== null && row?.value !== undefined && row.revision !== null && row.deleted_at === null;
    return { value: live ? row!.value : null, revision: live ? row!.revision : null, nextRevision: (row?.revision ?? 0) + 1 };
  }

  async getPlanningSettings(): Promise<PlanningSettings | null> {
    // One SQL statement reads a coherent settings/working-hours snapshot.
    const row = await this.d1.prepare(`SELECT timezone, buffer_minutes, revision,
      (SELECT json_group_array(json_object('weekday',weekday,'start',start_time,'end',end_time)) FROM
        (SELECT weekday,start_time,end_time FROM planning_working_hours WHERE settings_id = 1 ORDER BY weekday,start_time)) AS hours
      FROM planning_settings WHERE id = 1`)
      .first<{ timezone: string; buffer_minutes: number; revision: number; hours: string }>();
    if (!row) return null;
    const parsed = parsePlanningSettings({ timezone: row.timezone, bufferMinutes: row.buffer_minutes, revision: row.revision, workingHours: JSON.parse(row.hours) });
    if (!parsed.ok) throw new Error('Stored planning settings failed validation.');
    return parsed.value;
  }

  /** The raw stored receipt, version 1 or 2, with the hash recorded in its row. */
  private async readReceipt(id: CommandId): Promise<{ payloadHash: string; stored: StoredResult } | null> {
    const row: unknown = await this.d1.prepare('SELECT command_id,payload_hash,result_json,created_at FROM command_receipts WHERE command_id = ?').bind(id).first();
    if (!row) return null;
    const receipt = parseSchema(StoredReceiptSchema, row);
    if (!receipt.ok) throw new Error('Stored command receipt failed validation.');
    const stored = parseStoredResult(receipt.value.result_json);
    const result = stored.ok ? stored.value.result : null;
    if (!stored.ok || (result !== null && (result.commandId !== receipt.value.command_id || result.payloadHash !== receipt.value.payload_hash || result.serverNow !== receipt.value.created_at))) {
      throw new Error('Stored command result failed validation.');
    }
    return { payloadHash: receipt.value.payload_hash, stored: stored.value };
  }

  /**
   * Receipt for an envelope-based call. A version 2 receipt belongs to a tool request, whose hash
   * can never equal an envelope hash, so the ID is in use with a different payload.
   */
  private async getCommandReceipt(id: CommandId): Promise<ChangesResult | null> {
    const receipt = await this.readReceipt(id);
    if (!receipt) return null;
    if (receipt.stored.receiptVersion === 2 || receipt.stored.result === null) throw payloadConflict();
    return receipt.stored.result;
  }

  /**
   * Receipt-first lookup for a tool adapter: the stored response when this exact request already
   * committed, null when the ID is unused. Another request (or an envelope) on the ID conflicts.
   */
  async findToolReceipt(id: CommandId, tool: ReceiptTool, requestHash: string): Promise<{ response: unknown; result: ChangesResult | null } | null> {
    const receipt = await this.readReceipt(id);
    if (!receipt) return null;
    if (receipt.stored.receiptVersion !== 2 || receipt.stored.tool !== tool || receipt.payloadHash !== requestHash) throw payloadConflict();
    return { response: receipt.stored.response, result: receipt.stored.result };
  }

  async previewChanges(input: CommandEnvelope, options: { actionLog?: boolean } = {}): Promise<ChangesPreview> {
    const hash = await commandHash(input);
    const receipt = await this.getCommandReceipt(input.commandId);
    if (receipt) {
      if (receipt.payloadHash !== hash) throw payloadConflict();
      throw new CommandError({ code: 'already_applied', path: ['commandId'], message: 'This command has already committed.', retryable: false,
        recoveryHint: 'Call apply_changes with the identical envelope to retrieve its original receipt; use a new command ID for another change.' });
    }
    const clock = parseEventInstant(new Date().toISOString());
    if (!clock.ok) throw new Error('Invalid server clock.');
    const planned = await this.planCommand(input, hash, clock.value);
    const capacity = checkPlanCapacity(this.d1, options.actionLog ? await this.withActionLog(planned.plan, input, planned.result, clock.value) : planned.plan);
    if (!capacity.ok) { if(capacity.error.kind==='capacity_exceeded')throw new CommandError({code:'capacity_exceeded',path:['commands'],message:`Atomic command requires ${capacity.error.requiredStatements} SQL statements; the limit is 100.`,retryable:false,requiredStatements:capacity.error.requiredStatements,limit:100,recoveryHint:'Retain the complete intent and explicitly reduce the scope; never split atomic changes silently.'},413);throwAppError(capacity.error); }
    const { applied: _applied, ...result } = planned.result;
    return { ...result, dryRun: true, requiredStatements: capacity.value.requiredStatements };
  }

  /**
   * Apply an envelope. `actionLog` also writes one action-log entry per non-settings command
   * (kind as the tool name) in the same atomic plan; the MCP tool turns it on, REST does not.
   */
  async applyChanges(input: CommandEnvelope, options: { actionLog?: boolean } = {}): Promise<ChangesResult> {
    const hash = await commandHash(input);
    const replay = await this.getCommandReceipt(input.commandId);
    if (replay) {
      if (replay.payloadHash !== hash) throw payloadConflict();
      return replay;
    }
    const clock = parseEventInstant(new Date().toISOString());
    if (!clock.ok) throw new Error('Invalid server clock.');
    let planned: ReturnType<typeof planSettingsCommand>;
    try {
      planned = await this.planCommand(input, hash, clock.value);
    } catch (error) {
      if (error instanceof CommandError && ['revision_conflict', 'structural_conflict'].includes(error.detail.code)) {
        const raced = await this.getCommandReceipt(input.commandId);
        if (raced) {
          if (raced.payloadHash !== hash) throw payloadConflict();
          return raced;
        }
      }
      throw error;
    }
    // The plan that is capacity-checked is the plan that commits, action-log rows included.
    const plan = options.actionLog ? await this.withActionLog(planned.plan, input, planned.result, clock.value) : planned.plan;
    const capacity=checkPlanCapacity(this.d1,plan);
    if(!capacity.ok && capacity.error.kind==='capacity_exceeded')throw new CommandError({code:'capacity_exceeded',path:['commands'],message:`Atomic command requires ${capacity.error.requiredStatements} SQL statements; the limit is 100.`,retryable:false,requiredStatements:capacity.error.requiredStatements,limit:100,recoveryHint:'Retain intent and explicitly reduce the complete atomic scope.'},413);
    const applied = await applyPlan(this.d1, plan);
    if (applied.ok) return planned.result;
    // Concurrent identical execution can fail either the SQL revision guard or
    // receipt uniqueness. Re-read the committed receipt before reporting a
    // conflict, so a lost response never causes another mutation.
    const concurrentReplay = await this.getCommandReceipt(input.commandId);
    if (concurrentReplay) {
      if (concurrentReplay.payloadHash !== hash) throw payloadConflict();
      return concurrentReplay;
    }
    const command = input.commands[0]!;
    if(input.commands.length>1){await this.planCommand(input,hash,clock.value);}
    else if (command.kind === 'link.add' || command.kind === 'link.remove') {
      planLinkCommand(input, await readLinkContext(this.d1, linkCommandKey(command)), hash, clock.value);
    } else if (command.kind === 'preference.set') {
      const current = await this.readPreferenceState(command.key);
      if (current.revision !== command.expectedRevision) throw preferenceConflict(command, current);
    } else if (command.kind === 'planning.set') {
      const current = await this.getPlanningSettings();
      if ((current?.revision ?? null) !== command.expectedRevision) throw revisionConflict(command.expectedRevision, current);
    } else if (command.kind === 'task.create' || command.kind === 'project.create') {
      const current = await this.getEntitySnapshot(command.kind === 'task.create' ? { entity: 'task', id: command.id } : { entity: 'project', id: command.id });
      const conflict = creationConflict(input, current);
      if (conflict) throw conflict;
    } else {
      const current = await this.getEntitySnapshot(commandEntityKey(command));
      const conflict = entityCommandConflict(input, current);
      if (conflict) throw conflict;
      // Classify exhaustion reached by an unrelated writer after planning as
      // durable; repeatedly retrying a permanently full counter cannot help.
      if (command.kind === 'task.content.set' || command.kind === 'project.content.set') planContentCommand(input, current, hash, clock.value);
      else if (command.kind === 'task.complete' || command.kind === 'task.project.set' || command.kind === 'task.parent.set' || command.kind === 'task.delete' || command.kind === 'project.delete') await this.planCommand(input, hash, clock.value);
      else planStateCommand(input, current, hash, clock.value);
    }
    if (applied.error.kind === 'capacity_exceeded') throwAppError(applied.error);
    throw new CommandError({ code: 'storage_unavailable', path: [], message: 'The command could not be committed.', retryable: true,
      recoveryHint: 'Keep this command ID and payload; retry after the service recovers. No partial command was committed.' }, 503);
  }

  /**
   * Commit a tool call that compiled to a command envelope: the commands, the version 2 receipt
   * (tool name and complete response) and the action-log row land in one atomic plan, so a
   * failed command leaves no log entry and a replay returns the first response verbatim.
   * `respond` runs after planning, so every field of the response is known before the batch runs.
   */
  async commitToolEnvelope(input: CommandEnvelope, hook: { tool: ReceiptTool; requestHash: string; respond: (result: ChangesResult) => { response: unknown; log: ToolLogDraft | null } }): Promise<unknown> {
    const clock = parseEventInstant(new Date().toISOString());
    if (!clock.ok) throw new Error('Invalid server clock.');
    const planned = await this.planCommand(input, hook.requestHash, clock.value);
    const { response, log } = hook.respond(planned.result);
    const ops: Op[] = planned.plan.ops.map((op): Op => op.kind === 'receipt.insert' ? { ...op, stored: { tool: hook.tool, response } } : op);
    if (log) ops.push(this.logOp(log, clock.value));
    const plan = { ...planned.plan, ops };
    const capacity = checkPlanCapacity(this.d1, plan);
    if (!capacity.ok && capacity.error.kind === 'capacity_exceeded') throw new CommandError({ code: 'capacity_exceeded', path: ['commands'], message: `Atomic command requires ${capacity.error.requiredStatements} SQL statements; the limit is 100.`, retryable: false, requiredStatements: capacity.error.requiredStatements, limit: 100, recoveryHint: 'Reduce the atomic scope.' }, 413);
    const applied = await applyPlan(this.d1, plan);
    if (applied.ok) return response;
    // A concurrent identical request may have committed first: replay it rather than conflict.
    const replay = await this.findToolReceipt(input.commandId, hook.tool, hook.requestHash);
    if (replay) return replay.response;
    await this.planCommand(input, hook.requestHash, clock.value);       // throws the precise conflict if state moved
    throw new CommandError({ code: 'storage_unavailable', path: [], message: 'The command could not be committed.', retryable: true,
      recoveryHint: 'Keep this command ID and arguments; retry after the service recovers. No partial command was committed.' }, 503);
  }

  /**
   * Record a call that changes no entity. The command ID, the response and (where the legacy
   * handler logs) the action-log row commit together, guarded by the state the call was judged
   * a no-op against, so a retry after a lost response returns this response whatever happens next.
   */
  async commitToolNoop(args: { commandId: CommandId; tool: ReceiptTool; requestHash: string; guards: PreCheck[]; response: unknown; log: ToolLogDraft | null }): Promise<unknown> {
    const clock = parseEventInstant(new Date().toISOString());
    if (!clock.ok) throw new Error('Invalid server clock.');
    const ops: Op[] = [{ kind: 'receipt.insert_noop', commandId: args.commandId, payloadHash: args.requestHash, serverNow: clock.value, tool: args.tool, response: args.response }];
    if (args.log) ops.push(this.logOp(args.log, clock.value));
    const applied = await applyPlan(this.d1, { assertions: args.guards, ops });
    if (applied.ok) return args.response;
    const replay = await this.findToolReceipt(args.commandId, args.tool, args.requestHash);
    if (replay) return replay.response;
    // A guard failed: the state the no-op was judged against moved. The caller re-reads and recompiles.
    throw new CommandError({ code: 'revision_conflict', path: [], message: 'State changed while the call was being classified.', retryable: true,
      recoveryHint: 'Repeat the call; it is re-evaluated against current state.' });
  }

  /** Appends one action-log row per non-settings command (MCP only), so capacity sees the real plan. */
  private async withActionLog(plan: Plan, input: CommandEnvelope, result: ChangesResult, at: EventInstant): Promise<Plan> {
    const missing = linkEndpoints(input).filter(id => !titlesFrom(result).task.has(id));
    const extra = new Map((await Promise.all([...new Set(missing)].map(async id => [id, (await this.getTask(id))?.title] as const))).flatMap(([id, title]) => title ? [[id, title] as const] : []));
    return { ...plan, ops: [...plan.ops, ...commandLogDrafts(input, result, extra).map(log => this.logOp(log, at))] };
  }

  private logOp(log: ToolLogDraft, at: EventInstant): Op {
    return { kind: 'log.insert', entry: { id: 0, tool_name: log.tool_name, task_id: log.task_id, duty_id: null, title: log.title, detail: log.detail, created_at: at } };
  }

  async listLegacyDueDates(after: string | undefined, limit: number): Promise<LegacyDueRow[]> {
    const rows = await this.d1.prepare('SELECT id, due_date, due_all_day FROM tasks WHERE due_date IS NOT NULL AND id > ? ORDER BY id LIMIT ?')
      .bind(after ?? '', limit).all<{ id: string; due_date: string; due_all_day: number | null }>();
    return rows.results.map(row => {
      if (row.due_all_day !== null && row.due_all_day !== 0 && row.due_all_day !== 1) throw new Error('Invalid stored due_all_day marker.');
      return { ...row, due_all_day: row.due_all_day === null ? null : row.due_all_day === 1 };
    });
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
      duty_id: null,
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

  /** Newest-first command audit rows (the receipt's actor, reason and diff list). */
  async listCommandAudit(limit = 50): Promise<{ command_id: string; actor: string; reason: string | null; changes_json: string; created_at: string }[]> {
    return this.d1
      .prepare('SELECT command_id, actor, reason, changes_json, created_at FROM command_audit ORDER BY created_at DESC, command_id DESC LIMIT ?')
      .bind(limit)
      .all<{ command_id: string; actor: string; reason: string | null; changes_json: string; created_at: string }>()
      .then(r => r.results);
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

    const capacity = checkPlanCapacity(this.d1, importPlan.value);
    if (!capacity.ok) throwAppError(capacity.error);

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
