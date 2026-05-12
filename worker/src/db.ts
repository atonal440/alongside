import { nanoid } from 'nanoid';
import { drizzle } from 'drizzle-orm/d1';
import { eq, ne, inArray, isNull, lte, or, asc, desc, gt, and, sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import {
  tasks as tasksTable,
  projects as projectsTable,
  taskLinks as taskLinksTable,
  userPreferences as prefsTable,
  actionLog as actionLogTable,
  duties as dutiesTable,
} from '@shared/schema';
import type {
  Task, Project, TaskLink, ActionLog, Duty,
  TaskCreate, TaskUpdate, ProjectCreate, ProjectUpdate, DutyUpdate, DutyTaskCreate,
} from '@shared/types';
import { isFocused, readinessScore } from '@shared/readiness';

export type { ActionLog as ActionLogEntry };

export class LegacyRecurringTaskNeedsTimezoneError extends Error {
  constructor() {
    super('Set a valid timezone preference before completing legacy recurring tasks');
    this.name = 'LegacyRecurringTaskNeedsTimezoneError';
  }
}

export class TaskRecurrenceUnsupportedError extends Error {
  constructor() {
    super('Use duties for recurring work; tasks.recurrence is legacy-only');
    this.name = 'TaskRecurrenceUnsupportedError';
  }
}

export interface ExportPayload {
  version: 1;
  exported_at: string;
  projects: Project[];
  tasks: Task[];
  links: TaskLink[];
  preferences: Record<string, string>;
  action_log?: ActionLog[];
  duties?: Duty[];
}

export interface ImportResult {
  dry_run: boolean;
  would_delete?: { tasks: number; projects: number };
  would_insert?: { tasks: number; projects: number };
  inserted?: { projects: number; tasks: number; links: number; preferences: number; action_log: number; duties: number };
}

const DEFAULT_PREFERENCES: Record<string, string> = {
  sort_by: 'readiness',
  planning_prompt: 'auto',
  kickoff_nudge: 'always',
  session_log: 'ask_at_end',
  interruption_style: 'proactive',
  urgency_visibility: 'hide',
  timezone: 'UTC',
};

function now(): string {
  return new Date().toISOString();
}

function isValidDutyOffsetDays(value: unknown): value is number {
  return Number.isInteger(value) && Number.isFinite(value);
}

// Mirrors shared/readiness.ts isDeferred for SQL: a task is "not currently
// deferred" if its kind is 'none', or kind = 'until' with a non-future date.
function notDeferredCondition(nowIso: string) {
  return or(
    eq(tasksTable.defer_kind, 'none'),
    and(
      eq(tasksTable.defer_kind, 'until'),
      or(isNull(tasksTable.defer_until), lte(tasksTable.defer_until, nowIso)),
    ),
  );
}


export class DB {
  private drizzle: DrizzleD1Database;

  constructor(private d1: D1Database) {
    this.drizzle = drizzle(d1);
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
    if ('recurrence' in input && input.recurrence !== undefined && input.recurrence !== null) {
      throw new TaskRecurrenceUnsupportedError();
    }
    return this.insertTask(input, null, null);
  }

  async addTaskFromDuty(input: DutyTaskCreate): Promise<Task> {
    return this.insertTask(input, input.duty_id, input.duty_fire_at);
  }

  private async insertTask(input: TaskCreate, dutyId: string | null, dutyFireAt: string | null): Promise<Task> {
    const task: Task = {
      id: `t_${nanoid(5)}`,
      title: input.title,
      notes: input.notes ?? null,
      status: 'pending',
      due_date: input.due_date ?? null,
      recurrence: null,
      created_at: now(),
      updated_at: now(),
      defer_until: null,
      defer_kind: 'none',
      task_type: input.task_type ?? 'action',
      project_id: input.project_id ?? null,
      kickoff_note: input.kickoff_note ?? null,
      session_log: null,
      focused_until: null,
      duty_id: dutyId,
      duty_fire_at: dutyFireAt,
    };

    await this.drizzle.insert(tasksTable).values(task);
    return task;
  }

  async completeTask(id: string): Promise<{ completed: Task } | null> {
    const task = await this.getTask(id);
    if (!task) return null;
    if (task.recurrence && !task.duty_id) {
      throw new LegacyRecurringTaskNeedsTimezoneError();
    }

    const timestamp = now();
    await this.drizzle
      .update(tasksTable)
      .set({ status: 'done', focused_until: null, updated_at: timestamp })
      .where(eq(tasksTable.id, id));

    // Carry session_log forward to the parent duty so the next materialization
    // surfaces the user's most recent re-entry note. Schedule advancement is
    // handled by the duty's next_fire_at, not by completion — accidental
    // completion no longer shifts the schedule.
    if (task.duty_id && task.session_log) {
      await this.drizzle
        .update(dutiesTable)
        .set({ kickoff_note: task.session_log, updated_at: timestamp })
        .where(eq(dutiesTable.id, task.duty_id));
    }

    const completed = { ...task, status: 'done' as const, focused_until: null, updated_at: timestamp };
    return { completed };
  }

  async reopenTask(id: string): Promise<Task | null> {
    const timestamp = now();
    await this.drizzle
      .update(tasksTable)
      .set({ status: 'pending', defer_kind: 'none', defer_until: null, updated_at: timestamp })
      .where(eq(tasksTable.id, id));
    return this.getTask(id);
  }

  async deferTask(id: string, kind: 'until' | 'someday', until?: string | null): Promise<Task | null> {
    const timestamp = now();
    await this.drizzle
      .update(tasksTable)
      .set({
        defer_kind: kind,
        defer_until: kind === 'until' ? (until ?? null) : null,
        focused_until: null,
        updated_at: timestamp,
      })
      .where(eq(tasksTable.id, id));
    return this.getTask(id);
  }

  async clearDeferTask(id: string): Promise<Task | null> {
    const timestamp = now();
    await this.drizzle
      .update(tasksTable)
      .set({ defer_kind: 'none', defer_until: null, updated_at: timestamp })
      .where(eq(tasksTable.id, id));
    return this.getTask(id);
  }

  async updateTask(id: string, updates: TaskUpdate): Promise<Task | null> {
    if (updates.status === 'done') throw new Error('Use completeTask() to mark a task done');
    if (updates.recurrence !== undefined && updates.recurrence !== null) {
      throw new TaskRecurrenceUnsupportedError();
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

    patch.updated_at = now();
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

  async createProject(input: ProjectCreate): Promise<Project> {
    const project: Project = {
      id: `p_${nanoid(5)}`,
      title: input.title,
      notes: input.notes ?? null,
      kickoff_note: input.kickoff_note ?? null,
      status: 'active',
      created_at: now(),
      updated_at: now(),
    };

    await this.drizzle.insert(projectsTable).values(project);
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
    await this.drizzle.update(projectsTable).set(patch).where(eq(projectsTable.id, id));
    return this.getProject(id);
  }

  async deleteProject(id: string): Promise<boolean> {
    const ts = now();
    await this.drizzle
      .update(tasksTable)
      .set({ project_id: null, updated_at: ts })
      .where(eq(tasksTable.project_id, id));
    await this.drizzle
      .update(dutiesTable)
      .set({ project_id: null, updated_at: ts })
      .where(eq(dutiesTable.project_id, id));
    const result = await this.d1
      .prepare('DELETE FROM projects WHERE id = ?')
      .bind(id)
      .run();
    return result.meta.changes > 0;
  }

  // ── Duties ─────────────────────────────────────────────────────────────────

  async addDuty(input: {
    title: string;
    notes?: string | null;
    kickoff_note?: string | null;
    task_type?: 'action' | 'plan';
    project_id?: string | null;
    recurrence: string;
    due_offset_days?: number;
    next_fire_at: string;
    active?: boolean;
  }): Promise<Duty> {
    if (input.due_offset_days !== undefined && !isValidDutyOffsetDays(input.due_offset_days)) {
      throw new Error('due_offset_days must be an integer');
    }
    const ts = now();
    const duty: Duty = {
      id: `d_${nanoid(5)}`,
      title: input.title,
      notes: input.notes ?? null,
      kickoff_note: input.kickoff_note ?? null,
      task_type: input.task_type ?? 'action',
      project_id: input.project_id ?? null,
      recurrence: input.recurrence,
      due_offset_days: input.due_offset_days ?? 0,
      active: input.active ?? true,
      next_fire_at: input.next_fire_at,
      last_fired_at: null,
      created_at: ts,
      updated_at: ts,
    };
    await this.drizzle.insert(dutiesTable).values(duty);
    return duty;
  }

  async getDuty(id: string): Promise<Duty | null> {
    const result = await this.drizzle
      .select()
      .from(dutiesTable)
      .where(eq(dutiesTable.id, id))
      .limit(1);
    return result[0] ?? null;
  }

  async listDuties(): Promise<Duty[]> {
    return this.drizzle.select().from(dutiesTable).orderBy(asc(dutiesTable.created_at));
  }

  async listDueDuties(nowIso: string): Promise<Duty[]> {
    return this.drizzle
      .select()
      .from(dutiesTable)
      .where(and(eq(dutiesTable.active, true), lte(dutiesTable.next_fire_at, nowIso)))
      .orderBy(asc(dutiesTable.next_fire_at));
  }

  async findTaskByDutyFire(dutyId: string, fireAt: string): Promise<Task | null> {
    const rows = await this.drizzle
      .select()
      .from(tasksTable)
      .where(and(eq(tasksTable.duty_id, dutyId), eq(tasksTable.duty_fire_at, fireAt)))
      .limit(1);
    return rows[0] ?? null;
  }

  async listLegacyRecurringTasks(): Promise<Task[]> {
    return this.drizzle
      .select()
      .from(tasksTable)
      .where(and(eq(tasksTable.status, 'pending'), sql`${tasksTable.recurrence} IS NOT NULL`))
      .orderBy(asc(tasksTable.created_at));
  }

  async convertLegacyRecurringTaskToDuty(task: Task, fireAt: string, nowIso: string): Promise<void> {
    if (!task.recurrence) return;

    const dutyId = task.id.startsWith('t_') ? `d_${task.id.slice(2)}` : `d_${task.id}`;
    await this.d1.batch([
      this.d1
        .prepare(`
          INSERT OR IGNORE INTO duties (
            id, title, notes, kickoff_note, task_type, project_id,
            recurrence, due_offset_days, active, next_fire_at, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?, ?)
        `)
        .bind(
          dutyId,
          task.title,
          task.notes,
          task.kickoff_note,
          task.task_type,
          task.project_id,
          task.recurrence,
          fireAt,
          task.created_at,
          nowIso,
        ),
      this.d1
        .prepare(`
          UPDATE tasks
          SET duty_id = ?, duty_fire_at = ?, recurrence = NULL, updated_at = ?
          WHERE id = ? AND status = 'pending' AND recurrence IS NOT NULL
        `)
        .bind(dutyId, fireAt, nowIso, task.id),
    ]);
  }

  async clearLegacyTaskRecurrence(taskId: string, nowIso: string): Promise<void> {
    await this.d1
      .prepare(`
        UPDATE tasks
        SET recurrence = NULL, updated_at = ?
        WHERE id = ? AND duty_id IS NULL AND recurrence IS NOT NULL
      `)
      .bind(nowIso, taskId)
      .run();
  }

  async updateDuty(id: string, updates: DutyUpdate): Promise<Duty | null> {
    const patch: Partial<typeof dutiesTable.$inferInsert> = {};
    if (updates.title           !== undefined) patch.title           = updates.title;
    if (updates.notes           !== undefined) patch.notes           = updates.notes;
    if (updates.kickoff_note    !== undefined) patch.kickoff_note    = updates.kickoff_note;
    if (updates.task_type       !== undefined) patch.task_type       = updates.task_type;
    if (updates.project_id      !== undefined) patch.project_id      = updates.project_id;
    if (updates.recurrence      !== undefined) patch.recurrence      = updates.recurrence;
    if (updates.due_offset_days !== undefined) {
      if (!isValidDutyOffsetDays(updates.due_offset_days)) {
        throw new Error('due_offset_days must be an integer');
      }
      patch.due_offset_days = updates.due_offset_days;
    }
    if (updates.active          !== undefined) patch.active          = updates.active;
    if (updates.next_fire_at    !== undefined) patch.next_fire_at    = updates.next_fire_at;
    if (Object.keys(patch).length === 0) return this.getDuty(id);
    patch.updated_at = now();
    await this.drizzle.update(dutiesTable).set(patch).where(eq(dutiesTable.id, id));
    return this.getDuty(id);
  }

  async markDutyFired(id: string, firedAt: string, nextFireAt: string, nowIso: string): Promise<boolean> {
    const result = await this.d1
      .prepare(`
        UPDATE duties
        SET last_fired_at = ?, next_fire_at = ?, updated_at = ?
        WHERE id = ? AND next_fire_at = ?
      `)
      .bind(firedAt, nextFireAt, nowIso, id, firedAt)
      .run();
    return result.meta.changes > 0;
  }

  async setDutyActive(id: string, active: boolean, nowIso: string, expectedNextFireAt?: string): Promise<boolean> {
    const activeValue = active ? 1 : 0;
    const result = expectedNextFireAt === undefined
      ? await this.d1
        .prepare('UPDATE duties SET active = ?, updated_at = ? WHERE id = ?')
        .bind(activeValue, nowIso, id)
        .run()
      : await this.d1
        .prepare('UPDATE duties SET active = ?, updated_at = ? WHERE id = ? AND next_fire_at = ?')
        .bind(activeValue, nowIso, id, expectedNextFireAt)
        .run();
    return result.meta.changes > 0;
  }

  async deleteDuty(id: string): Promise<boolean> {
    const result = await this.d1
      .prepare('DELETE FROM duties WHERE id = ?')
      .bind(id)
      .run();
    return result.meta.changes > 0;
  }

  // ── Task Links ─────────────────────────────────────────────────────────────

  async linkTasks(fromTaskId: string, toTaskId: string, linkType: TaskLink['link_type']): Promise<void> {
    await this.d1
      .prepare('INSERT OR REPLACE INTO task_links (from_task_id, to_task_id, link_type) VALUES (?, ?, ?)')
      .bind(fromTaskId, toTaskId, linkType)
      .run();
  }

  async unlinkTasks(fromTaskId: string, toTaskId: string, linkType: TaskLink['link_type']): Promise<void> {
    await this.drizzle
      .delete(taskLinksTable)
      .where(and(
        eq(taskLinksTable.from_task_id, fromTaskId),
        eq(taskLinksTable.to_task_id, toTaskId),
        eq(taskLinksTable.link_type, linkType),
      ));
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
      if (key === 'timezone') continue;
      await this.d1
        .prepare('INSERT OR IGNORE INTO user_preferences (key, value) VALUES (?, ?)')
        .bind(key, value)
        .run();
    }
  }

  // ── Archive / Restore ──────────────────────────────────────────────────────

  async exportAll(includeLog = false): Promise<ExportPayload> {
    const [taskRows, projectRows, linkRows, prefRows, dutyRows, logRows] = await Promise.all([
      this.drizzle.select().from(tasksTable),
      this.drizzle.select().from(projectsTable),
      this.drizzle.select().from(taskLinksTable),
      this.drizzle.select().from(prefsTable),
      this.drizzle.select().from(dutiesTable),
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
      duties: dutyRows,
    };
    if (includeLog) payload.action_log = logRows;
    return payload;
  }

  async importAll(payload: ExportPayload, dryRun = false): Promise<ImportResult> {
    validateExportPayload(payload);

    if (dryRun) {
      const [taskCount, projectCount] = await Promise.all([
        this.drizzle.select({ n: sql<number>`count(*)` }).from(tasksTable),
        this.drizzle.select({ n: sql<number>`count(*)` }).from(projectsTable),
      ]);
      return {
        dry_run: true,
        would_delete: { tasks: taskCount[0].n, projects: projectCount[0].n },
        would_insert: { tasks: payload.tasks.length, projects: payload.projects.length },
      };
    }

    // Build all statements: wipe then insert in FK-safe order
    const stmts: D1PreparedStatement[] = [
      this.d1.prepare('DELETE FROM task_links'),
      this.d1.prepare('DELETE FROM action_log'),
      this.d1.prepare('DELETE FROM tasks'),
      this.d1.prepare('DELETE FROM duties'),
      this.d1.prepare('DELETE FROM projects'),
      this.d1.prepare('DELETE FROM user_preferences'),
    ];

    for (const p of payload.projects) {
      stmts.push(
        this.d1
          .prepare('INSERT INTO projects (id,title,notes,kickoff_note,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)')
          .bind(p.id, p.title, p.notes, p.kickoff_note, p.status, p.created_at, p.updated_at)
      );
    }

    for (const d of payload.duties ?? []) {
      stmts.push(
        this.d1
          .prepare('INSERT INTO duties (id,title,notes,kickoff_note,task_type,project_id,recurrence,due_offset_days,active,next_fire_at,last_fired_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .bind(d.id, d.title, d.notes, d.kickoff_note, d.task_type, d.project_id, d.recurrence, d.due_offset_days, d.active ? 1 : 0, d.next_fire_at, d.last_fired_at, d.created_at, d.updated_at)
      );
    }

    for (const t of payload.tasks) {
      // Legacy translation: exports created before migration 006 carry
      // `snoozed_until` instead of `defer_kind`/`defer_until`. Both shapes
      // claim `version: 1`, so we detect the old shape by the absence of
      // `defer_kind` and rewrite a non-null `snoozed_until` as a timed
      // defer. Without this, restoring an old backup silently un-snoozes
      // every previously-snoozed task.
      const legacy = t as Task & { snoozed_until?: string | null };
      const hasNewFields = legacy.defer_kind !== undefined;
      const deferKind: 'none' | 'until' | 'someday' = hasNewFields
        ? (legacy.defer_kind ?? 'none')
        : (legacy.snoozed_until ? 'until' : 'none');
      const deferUntil: string | null = hasNewFields
        ? (legacy.defer_until ?? null)
        : (legacy.snoozed_until ?? null);

      const dutyId = (t as Task).duty_id ?? null;
      const dutyFireAt = (t as Task).duty_fire_at ?? null;
      stmts.push(
        this.d1
          .prepare('INSERT INTO tasks (id,title,notes,status,due_date,recurrence,created_at,updated_at,defer_until,defer_kind,task_type,project_id,kickoff_note,session_log,focused_until,duty_id,duty_fire_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .bind(t.id, t.title, t.notes, t.status, t.due_date, t.recurrence, t.created_at, t.updated_at, deferUntil, deferKind, t.task_type, t.project_id, t.kickoff_note, t.session_log, t.focused_until, dutyId, dutyFireAt)
      );
    }

    for (const l of payload.links) {
      stmts.push(
        this.d1
          .prepare('INSERT INTO task_links (from_task_id,to_task_id,link_type) VALUES (?,?,?)')
          .bind(l.from_task_id, l.to_task_id, l.link_type)
      );
    }

    for (const [key, value] of Object.entries(payload.preferences)) {
      stmts.push(
        this.d1.prepare('INSERT INTO user_preferences (key,value) VALUES (?,?)').bind(key, value)
      );
    }

    const logEntries = payload.action_log ?? [];
    for (const e of logEntries) {
      stmts.push(
        this.d1
          .prepare('INSERT INTO action_log (tool_name,task_id,title,detail,created_at) VALUES (?,?,?,?,?)')
          .bind(e.tool_name, e.task_id, e.title, e.detail, e.created_at)
      );
    }

    // Execute atomically when possible; chunk when the batch is too large.
    // D1 has no cross-batch transaction primitive, so the chunked path is not
    // fully atomic. We validate payload integrity first to eliminate the most
    // likely mid-import failure cause (bad references / duplicates). A D1
    // network error mid-chunk would still leave the DB partially restored —
    // callers should keep their export file as a backup.
    const CHUNK = 100;
    if (stmts.length <= CHUNK) {
      await this.d1.batch(stmts);
    } else {
      validatePayloadIntegrity(payload);
      await this.d1.batch(stmts.slice(0, 6)); // wipe
      for (let i = 6; i < stmts.length; i += CHUNK) {
        await this.d1.batch(stmts.slice(i, i + CHUNK));
      }
    }

    return {
      dry_run: false,
      inserted: {
        projects: payload.projects.length,
        tasks: payload.tasks.length,
        links: payload.links.length,
        preferences: Object.keys(payload.preferences).length,
        action_log: logEntries.length,
        duties: (payload.duties ?? []).length,
      },
    };
  }
}

// Deep integrity check run before the chunked (non-atomic) import path.
// Catches bad references and duplicates so the wipe-then-insert sequence
// is unlikely to fail partway through.
function validatePayloadIntegrity(payload: ExportPayload): void {
  const projectIds = new Set(payload.projects.map(p => p.id));
  const taskIds = new Set(payload.tasks.map(t => t.id));
  const dutyIds = new Set((payload.duties ?? []).map(d => d.id));

  const dupProjects = payload.projects.length - projectIds.size;
  if (dupProjects > 0) throw new Error(`Payload contains ${dupProjects} duplicate project id(s)`);

  const dupTasks = payload.tasks.length - taskIds.size;
  if (dupTasks > 0) throw new Error(`Payload contains ${dupTasks} duplicate task id(s)`);

  const dupDuties = (payload.duties ?? []).length - dutyIds.size;
  if (dupDuties > 0) throw new Error(`Payload contains ${dupDuties} duplicate duty id(s)`);

  for (const duty of payload.duties ?? []) {
    if (!isValidDutyOffsetDays(duty.due_offset_days)) {
      throw new Error(`Duty ${duty.id} has invalid due_offset_days`);
    }
    if (duty.project_id !== null && !projectIds.has(duty.project_id)) {
      throw new Error(`Duty ${duty.id} references unknown project ${duty.project_id}`);
    }
  }

  const dutyFireKeys = new Set<string>();
  for (const task of payload.tasks) {
    if (task.project_id !== null && !projectIds.has(task.project_id)) {
      throw new Error(`Task ${task.id} references unknown project ${task.project_id}`);
    }
    const dutyId = (task as Task).duty_id ?? null;
    const dutyFireAt = (task as Task).duty_fire_at ?? null;
    if (dutyId !== null) {
      if (!dutyIds.has(dutyId)) {
        throw new Error(`Task ${task.id} references unknown duty ${dutyId}`);
      }
      if (dutyFireAt === null) {
        throw new Error(`Task ${task.id} has duty_id without duty_fire_at`);
      }
      const dutyFireKey = `${dutyId}\u0000${dutyFireAt}`;
      if (dutyFireKeys.has(dutyFireKey)) {
        throw new Error(`Payload contains duplicate task duty fire ${dutyId} / ${dutyFireAt}`);
      }
      dutyFireKeys.add(dutyFireKey);
    }
  }

  for (const link of payload.links) {
    if (!taskIds.has(link.from_task_id)) {
      throw new Error(`Link references unknown task ${link.from_task_id}`);
    }
    if (!taskIds.has(link.to_task_id)) {
      throw new Error(`Link references unknown task ${link.to_task_id}`);
    }
  }
}

function validateExportPayload(payload: unknown): asserts payload is ExportPayload {
  if (typeof payload !== 'object' || payload === null) throw new Error('Payload must be a JSON object');
  const p = payload as Record<string, unknown>;
  if (p['version'] !== 1) throw new Error('Unsupported export version (expected 1)');
  if (!Array.isArray(p['projects'])) throw new Error('Missing or invalid projects array');
  if (!Array.isArray(p['tasks'])) throw new Error('Missing or invalid tasks array');
  if (!Array.isArray(p['links'])) throw new Error('Missing or invalid links array');
  if (p['duties'] !== undefined && !Array.isArray(p['duties'])) throw new Error('Invalid duties array');
  if (typeof p['preferences'] !== 'object' || p['preferences'] === null || Array.isArray(p['preferences'])) {
    throw new Error('Missing or invalid preferences object');
  }
}
