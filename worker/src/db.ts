import { nanoid } from 'nanoid';

export interface Task {
  id: string;
  title: string;
  notes: string | null;
  status: 'pending' | 'active' | 'done' | 'snoozed';
  due_date: string | null;
  recurrence: string | null;
  session_id: string | null;
  created_at: string;
  updated_at: string;
  snoozed_until: string | null;
  task_type: 'action' | 'plan' | 'recurring';
  project_id: string | null;
  kickoff_note: string | null;
  session_log: string | null;
}

export interface Project {
  id: string;
  title: string;
  kickoff_note: string | null;
  status: 'active' | 'archived';
  created_at: string;
  updated_at: string;
}

export interface TaskLink {
  from_task_id: string;
  to_task_id: string;
  link_type: 'blocks' | 'related' | 'supersedes';
}

export type TaskCreate = Pick<Task, 'title'> &
  Partial<Pick<Task, 'notes' | 'due_date' | 'recurrence' | 'task_type' | 'project_id' | 'kickoff_note'>>;

export type TaskUpdate = Partial<Pick<Task, 'title' | 'notes' | 'due_date' | 'recurrence' | 'task_type' | 'project_id' | 'kickoff_note' | 'session_log' | 'status' | 'snoozed_until'>>;

export type ProjectCreate = Pick<Project, 'title'> & Partial<Pick<Project, 'kickoff_note'>>;
export type ProjectUpdate = Partial<Pick<Project, 'title' | 'kickoff_note' | 'status'>>;

export interface ActionLogEntry {
  id: number;
  tool_name: string;
  task_id: string | null;
  title: string;
  detail: string | null;
  created_at: string;
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

// Readiness score: higher = more ready to start right now.
// All tasks passed here are assumed unblocked (get_ready_tasks pre-filters).
function readinessScore(task: Task): number {
  let score = 3; // base: no unresolved blocks (pre-filtered)
  if (task.kickoff_note) score += 3;
  if (task.session_log) score += 2;
  if (task.due_date) {
    const daysUntilDue = (new Date(task.due_date).getTime() - Date.now()) / 86400000;
    if (daysUntilDue >= 0 && daysUntilDue <= 7) score += 1;
  }
  if (task.session_id && (Date.now() - new Date(task.updated_at).getTime()) < 14 * 86400000) {
    score += 1;
  }
  return score;
}

export class DB {
  constructor(private d1: D1Database) {}

  // ── Tasks ──────────────────────────────────────────────────────────────────

  async listTasks(statuses: string[] = ['pending', 'active']): Promise<Task[]> {
    const placeholders = statuses.map(() => '?').join(', ');
    const result = await this.d1
      .prepare(`SELECT * FROM tasks WHERE status IN (${placeholders}) ORDER BY due_date ASC, created_at ASC`)
      .bind(...statuses)
      .all<Task>();
    return result.results;
  }

  async getActiveTasks(sessionId?: string): Promise<Task[]> {
    if (sessionId) {
      const result = await this.d1
        .prepare('SELECT * FROM tasks WHERE status = ? AND session_id = ? ORDER BY created_at ASC')
        .bind('active', sessionId)
        .all<Task>();
      return result.results;
    }
    const result = await this.d1
      .prepare('SELECT * FROM tasks WHERE status = ? ORDER BY created_at ASC')
      .bind('active')
      .all<Task>();
    return result.results;
  }

  async getTask(id: string): Promise<Task | null> {
    const result = await this.d1
      .prepare('SELECT * FROM tasks WHERE id = ?')
      .bind(id)
      .first<Task>();
    return result ?? null;
  }

  async addTask(input: TaskCreate): Promise<Task> {
    const task: Task = {
      id: `t_${nanoid(5)}`,
      title: input.title,
      notes: input.notes ?? null,
      status: 'pending',
      due_date: input.due_date ?? null,
      recurrence: input.recurrence ?? null,
      session_id: null,
      created_at: now(),
      updated_at: now(),
      snoozed_until: null,
      task_type: input.task_type ?? 'action',
      project_id: input.project_id ?? null,
      kickoff_note: input.kickoff_note ?? null,
      session_log: null,
    };

    await this.d1
      .prepare(
        `INSERT INTO tasks
           (id, title, notes, status, due_date, recurrence, session_id,
            created_at, updated_at, snoozed_until, task_type, project_id, kickoff_note, session_log)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        task.id, task.title, task.notes, task.status, task.due_date,
        task.recurrence, task.session_id, task.created_at, task.updated_at,
        task.snoozed_until, task.task_type, task.project_id, task.kickoff_note, task.session_log
      )
      .run();

    return task;
  }

  async activateTask(id: string, sessionId: string): Promise<Task | null> {
    const timestamp = now();
    await this.d1
      .prepare('UPDATE tasks SET status = ?, session_id = ?, updated_at = ? WHERE id = ?')
      .bind('active', sessionId, timestamp, id)
      .run();
    return this.getTask(id);
  }

  async completeTask(id: string): Promise<{ completed: Task; next?: Task } | null> {
    const task = await this.getTask(id);
    if (!task) return null;

    const timestamp = now();
    await this.d1
      .prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?')
      .bind('done', timestamp, id)
      .run();

    const completed = { ...task, status: 'done' as const, updated_at: timestamp };

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
    await this.d1
      .prepare('UPDATE tasks SET status = ?, snoozed_until = NULL, updated_at = ? WHERE id = ?')
      .bind('pending', timestamp, id)
      .run();
    return this.getTask(id);
  }

  async snoozeTask(id: string, until: string): Promise<Task | null> {
    const timestamp = now();
    await this.d1
      .prepare('UPDATE tasks SET status = ?, snoozed_until = ?, updated_at = ? WHERE id = ?')
      .bind('snoozed', until, timestamp, id)
      .run();
    return this.getTask(id);
  }

  async updateTask(id: string, updates: TaskUpdate): Promise<Task | null> {
    const fields: string[] = [];
    const values: (string | null)[] = [];

    if (updates.title !== undefined) { fields.push('title = ?'); values.push(updates.title); }
    if (updates.notes !== undefined) { fields.push('notes = ?'); values.push(updates.notes); }
    if (updates.due_date !== undefined) { fields.push('due_date = ?'); values.push(updates.due_date); }
    if (updates.recurrence !== undefined) { fields.push('recurrence = ?'); values.push(updates.recurrence); }
    if (updates.task_type !== undefined) { fields.push('task_type = ?'); values.push(updates.task_type); }
    if (updates.project_id !== undefined) { fields.push('project_id = ?'); values.push(updates.project_id); }
    if (updates.kickoff_note !== undefined) { fields.push('kickoff_note = ?'); values.push(updates.kickoff_note); }
    if (updates.session_log !== undefined) { fields.push('session_log = ?'); values.push(updates.session_log); }
    if (updates.status !== undefined) {
      if (updates.status === 'done') throw new Error('Use completeTask() to mark a task done');
      fields.push('status = ?'); values.push(updates.status);
    }
    if (updates.snoozed_until !== undefined) { fields.push('snoozed_until = ?'); values.push(updates.snoozed_until); }

    if (fields.length === 0) return this.getTask(id);

    const timestamp = now();
    fields.push('updated_at = ?');
    values.push(timestamp);
    values.push(id);

    await this.d1
      .prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`)
      .bind(...values)
      .run();

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
    let sql = `
      SELECT t.* FROM tasks t
      WHERE t.status IN ('pending', 'active')
      AND NOT EXISTS (
        SELECT 1 FROM task_links tl
        JOIN tasks blocker ON tl.from_task_id = blocker.id
        WHERE tl.to_task_id = t.id
          AND tl.link_type = 'blocks'
          AND blocker.status != 'done'
      )
    `;
    const bindings: (string)[] = [];
    if (projectId) {
      sql += ' AND t.project_id = ?';
      bindings.push(projectId);
    }

    const result = await this.d1.prepare(sql).bind(...bindings).all<Task>();
    return result.results.sort((a, b) => readinessScore(b) - readinessScore(a));
  }

  // ── Projects ───────────────────────────────────────────────────────────────

  async createProject(input: ProjectCreate): Promise<Project> {
    const project: Project = {
      id: `p_${nanoid(5)}`,
      title: input.title,
      kickoff_note: input.kickoff_note ?? null,
      status: 'active',
      created_at: now(),
      updated_at: now(),
    };

    await this.d1
      .prepare(
        `INSERT INTO projects (id, title, kickoff_note, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(project.id, project.title, project.kickoff_note, project.status, project.created_at, project.updated_at)
      .run();

    return project;
  }

  async getProject(id: string): Promise<Project | null> {
    const result = await this.d1
      .prepare('SELECT * FROM projects WHERE id = ?')
      .bind(id)
      .first<Project>();
    return result ?? null;
  }

  async listProjects(status?: string): Promise<Project[]> {
    if (status) {
      const result = await this.d1
        .prepare('SELECT * FROM projects WHERE status = ? ORDER BY created_at ASC')
        .bind(status)
        .all<Project>();
      return result.results;
    }
    const result = await this.d1
      .prepare('SELECT * FROM projects ORDER BY created_at ASC')
      .all<Project>();
    return result.results;
  }

  async updateProject(id: string, updates: ProjectUpdate): Promise<Project | null> {
    const fields: string[] = [];
    const values: (string | null)[] = [];

    if (updates.title !== undefined) { fields.push('title = ?'); values.push(updates.title); }
    if (updates.kickoff_note !== undefined) { fields.push('kickoff_note = ?'); values.push(updates.kickoff_note); }
    if (updates.status !== undefined) { fields.push('status = ?'); values.push(updates.status); }

    if (fields.length === 0) return this.getProject(id);

    const timestamp = now();
    fields.push('updated_at = ?');
    values.push(timestamp);
    values.push(id);

    await this.d1
      .prepare(`UPDATE projects SET ${fields.join(', ')} WHERE id = ?`)
      .bind(...values)
      .run();

    return this.getProject(id);
  }

  // ── Task Links ─────────────────────────────────────────────────────────────

  async linkTasks(fromTaskId: string, toTaskId: string, linkType: TaskLink['link_type']): Promise<void> {
    await this.d1
      .prepare(
        `INSERT OR REPLACE INTO task_links (from_task_id, to_task_id, link_type) VALUES (?, ?, ?)`
      )
      .bind(fromTaskId, toTaskId, linkType)
      .run();
  }

  async unlinkTasks(fromTaskId: string, toTaskId: string, linkType: TaskLink['link_type']): Promise<void> {
    await this.d1
      .prepare('DELETE FROM task_links WHERE from_task_id = ? AND to_task_id = ? AND link_type = ?')
      .bind(fromTaskId, toTaskId, linkType)
      .run();
  }

  async getTaskLinks(taskId: string): Promise<TaskLink[]> {
    const result = await this.d1
      .prepare(
        `SELECT * FROM task_links WHERE from_task_id = ? OR to_task_id = ?`
      )
      .bind(taskId, taskId)
      .all<TaskLink>();
    return result.results;
  }

  async listAllLinks(): Promise<TaskLink[]> {
    const result = await this.d1
      .prepare('SELECT * FROM task_links')
      .all<TaskLink>();
    return result.results;
  }

  // ── Preferences ───────────────────────────────────────────────────────────

  async getPreference(key: string): Promise<string | null> {
    const result = await this.d1
      .prepare('SELECT value FROM user_preferences WHERE key = ?')
      .bind(key)
      .first<{ value: string }>();
    return result?.value ?? null;
  }

  async setPreference(key: string, value: string): Promise<void> {
    await this.d1
      .prepare('INSERT OR REPLACE INTO user_preferences (key, value) VALUES (?, ?)')
      .bind(key, value)
      .run();
  }

  async getAllPreferences(): Promise<Record<string, string>> {
    const result = await this.d1
      .prepare('SELECT key, value FROM user_preferences')
      .all<{ key: string; value: string }>();
    const prefs: Record<string, string> = { ...DEFAULT_PREFERENCES };
    for (const row of result.results) {
      prefs[row.key] = row.value;
    }
    return prefs;
  }

  // ── Action Log ─────────────────────────────────────────────────────────────

  async logAction(entry: { tool_name: string; task_id?: string; title: string; detail?: string }): Promise<ActionLogEntry> {
    const created_at = now();
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

  async getActionLog(limit = 50): Promise<ActionLogEntry[]> {
    const result = await this.d1
      .prepare('SELECT * FROM action_log ORDER BY id DESC LIMIT ?')
      .bind(limit)
      .all<ActionLogEntry>();
    return result.results;
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
}
