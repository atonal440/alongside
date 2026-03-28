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
}

export type TaskCreate = Pick<Task, 'title'> &
  Partial<Pick<Task, 'notes' | 'due_date' | 'recurrence'>>;

export type TaskUpdate = Partial<Pick<Task, 'title' | 'notes' | 'due_date' | 'recurrence'>>;

function now(): string {
  return new Date().toISOString();
}

function parseNextOccurrence(rrule: string, fromDate: string): string | null {
  // Minimal RRULE parser for common cases:
  // FREQ=DAILY;INTERVAL=1
  // FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,WE,FR
  // FREQ=MONTHLY;INTERVAL=1
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

export class DB {
  constructor(private d1: D1Database) {}

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
    };

    await this.d1
      .prepare(
        `INSERT INTO tasks (id, title, notes, status, due_date, recurrence, session_id, created_at, updated_at, snoozed_until)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        task.id, task.title, task.notes, task.status, task.due_date,
        task.recurrence, task.session_id, task.created_at, task.updated_at,
        task.snoozed_until
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

    // Handle recurrence: create a new pending task with the next due date
    if (task.recurrence && task.due_date) {
      const nextDue = parseNextOccurrence(task.recurrence, task.due_date);
      if (nextDue) {
        const next = await this.addTask({
          title: task.title,
          notes: task.notes ?? undefined,
          due_date: nextDue,
          recurrence: task.recurrence,
        });
        return { completed, next };
      }
    }

    return { completed };
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
}
