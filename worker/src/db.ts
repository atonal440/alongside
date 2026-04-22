import { nanoid } from 'nanoid';
import { drizzle } from 'drizzle-orm/d1';
import { eq, inArray, isNull, lte, or, asc, desc, gt, and, sql } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import {
  tasks as tasksTable,
  projects as projectsTable,
  taskLinks as taskLinksTable,
  userPreferences as prefsTable,
  actionLog as actionLogTable,
} from '@shared/schema';
import type { Task, Project, TaskLink, ActionLog, TaskCreate, TaskUpdate, ProjectCreate, ProjectUpdate } from '@shared/types';

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

function now(): string {
  return new Date().toISOString();
}

function parseNextOccurrence(rrule: string, fromDate: string): string | null {
  const parts: Record<string, string> = {};
  for (const part of rrule.split(';')) {
    const [key, val] = part.split('=');
    if (key && val) parts[key] = val;
  }

  const freq = parts['FREQ'];
  const interval = parseInt(parts['INTERVAL'] || '1', 10);
  const date = new Date(fromDate);

  switch (freq) {
    case 'DAILY':
      date.setDate(date.getDate() + interval);
      break;
    case 'WEEKLY':
      date.setDate(date.getDate() + 7 * interval);
      break;
    case 'MONTHLY':
      date.setMonth(date.getMonth() + interval);
      break;
    case 'YEARLY':
      date.setFullYear(date.getFullYear() + interval);
      break;
    default:
      return null;
  }

  return date.toISOString().split('T')[0];
}

function isFocused(task: Task): boolean {
  return !!task.focused_until && task.focused_until > new Date().toISOString();
}

// Readiness score: higher = more ready to start right now.
// All tasks passed here are assumed unblocked (get_ready_tasks pre-filters).
function readinessScore(task: Task): number {
  let score = 3; // base: no unresolved blocks (pre-filtered)
  if (isFocused(task)) score += 5;
  if (task.kickoff_note) score += 3;
  if (task.session_log) score += 2;
  if (task.due_date) {
    const daysUntilDue = (new Date(task.due_date).getTime() - Date.now()) / 86400000;
    if (daysUntilDue >= 0 && daysUntilDue <= 7) score += 1;
  }
  if ((Date.now() - new Date(task.updated_at).getTime()) < 14 * 86400000) {
    score += 1;
  }
  return score;
}

export class DB {
  private drizzle: DrizzleD1Database;

  constructor(private d1: D1Database) {
    this.drizzle = drizzle(d1);
  }

  // ── Tasks ──────────────────────────────────────────────────────────────────

  // Returns actionable tasks — excludes tasks that are currently snoozed.
  async listTasks(statuses: Task['status'][] = ['pending']): Promise<Task[]> {
    const ts = now();
    return this.drizzle
      .select()
      .from(tasksTable)
      .where(and(
        inArray(tasksTable.status, statuses),
        or(isNull(tasksTable.snoozed_until), lte(tasksTable.snoozed_until, ts)),
      ))
      .orderBy(asc(tasksTable.due_date), asc(tasksTable.created_at));
  }

  // Returns all tasks including currently-snoozed ones. Used for PWA full sync.
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
    const task: Task = {
      id: `t_${nanoid(5)}`,
      title: input.title,
      notes: input.notes ?? null,
      status: 'pending',
      due_date: input.due_date ?? null,
      recurrence: input.recurrence ?? null,
      created_at: now(),
      updated_at: now(),
      snoozed_until: null,
      task_type: input.task_type ?? 'action',
      project_id: input.project_id ?? null,
      kickoff_note: input.kickoff_note ?? null,
      session_log: null,
      focused_until: null,
    };

    await this.drizzle.insert(tasksTable).values(task);
    return task;
  }

  async completeTask(id: string): Promise<{ completed: Task; next?: Task } | null> {
    const task = await this.getTask(id);
    if (!task) return null;

    const timestamp = now();
    await this.drizzle
      .update(tasksTable)
      .set({ status: 'done', focused_until: null, updated_at: timestamp })
      .where(eq(tasksTable.id, id));

    const completed = { ...task, status: 'done' as const, focused_until: null, updated_at: timestamp };

    if (task.recurrence && task.due_date) {
      const nextDue = parseNextOccurrence(task.recurrence, task.due_date);
      if (nextDue) {
        // Carry kickoff_note forward from session_log for recurring tasks
        const nextKickoff = task.session_log ?? task.kickoff_note ?? null;
        const next = await this.addTask({
          title: task.title,
          notes: task.notes ?? undefined,
          due_date: nextDue,
          recurrence: task.recurrence,
          task_type: task.task_type,
          project_id: task.project_id ?? undefined,
          kickoff_note: nextKickoff ?? undefined,
        });
        return { completed, next };
      }
    }

    return { completed };
  }

  async reopenTask(id: string): Promise<Task | null> {
    const timestamp = now();
    await this.drizzle
      .update(tasksTable)
      .set({ status: 'pending', snoozed_until: null, updated_at: timestamp })
      .where(eq(tasksTable.id, id));
    return this.getTask(id);
  }

  async snoozeTask(id: string, until: string): Promise<Task | null> {
    const timestamp = now();
    await this.drizzle
      .update(tasksTable)
      .set({ snoozed_until: until, focused_until: null, updated_at: timestamp })
      .where(eq(tasksTable.id, id));
    return this.getTask(id);
  }

  async updateTask(id: string, updates: TaskUpdate): Promise<Task | null> {
    if (updates.status === 'done') throw new Error('Use completeTask() to mark a task done');

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
    if (updates.snoozed_until !== undefined) patch.snoozed_until = updates.snoozed_until;
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
      or(isNull(tasksTable.snoozed_until), lte(tasksTable.snoozed_until, ts)),
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

    return results.sort((a, b) => readinessScore(b) - readinessScore(a));
  }

  // Returns tasks whose focused_until is still in the future.
  async listFocusedTasks(): Promise<Task[]> {
    const ts = now();
    return this.drizzle
      .select()
      .from(tasksTable)
      .where(and(
        gt(tasksTable.focused_until, ts),
        or(isNull(tasksTable.snoozed_until), lte(tasksTable.snoozed_until, ts)),
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

    for (const t of payload.tasks) {
      stmts.push(
        this.d1
          .prepare('INSERT INTO tasks (id,title,notes,status,due_date,recurrence,created_at,updated_at,snoozed_until,task_type,project_id,kickoff_note,session_log,focused_until) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .bind(t.id, t.title, t.notes, t.status, t.due_date, t.recurrence, t.created_at, t.updated_at, t.snoozed_until, t.task_type, t.project_id, t.kickoff_note, t.session_log, t.focused_until)
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

    // Execute atomically when possible; chunk when the batch is too large
    const CHUNK = 100;
    if (stmts.length <= CHUNK) {
      await this.d1.batch(stmts);
    } else {
      // Wipe atomically first, then insert in chunks
      await this.d1.batch(stmts.slice(0, 5));
      for (let i = 5; i < stmts.length; i += CHUNK) {
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
      },
    };
  }
}

function validateExportPayload(payload: unknown): asserts payload is ExportPayload {
  if (typeof payload !== 'object' || payload === null) throw new Error('Payload must be a JSON object');
  const p = payload as Record<string, unknown>;
  if (p['version'] !== 1) throw new Error('Unsupported export version (expected 1)');
  if (!Array.isArray(p['projects'])) throw new Error('Missing or invalid projects array');
  if (!Array.isArray(p['tasks'])) throw new Error('Missing or invalid tasks array');
  if (!Array.isArray(p['links'])) throw new Error('Missing or invalid links array');
  if (typeof p['preferences'] !== 'object' || p['preferences'] === null || Array.isArray(p['preferences'])) {
    throw new Error('Missing or invalid preferences object');
  }
}
