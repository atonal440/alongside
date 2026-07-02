import type { Task, TaskLink } from './schema';

export function isDeferred(task: Pick<Task, 'defer_kind' | 'defer_until'>, nowIso: string): boolean {
  if (task.defer_kind === 'someday') return true;
  if (task.defer_kind === 'until') {
    return !!task.defer_until && task.defer_until > nowIso;
  }
  return false;
}

export function hasActiveBlocker(task: Pick<Task, 'id'>, links: TaskLink[], tasks: Task[]): boolean {
  const taskById = new Map(tasks.map(candidate => [candidate.id, candidate]));
  return links.some(link => {
    if (link.link_type !== 'blocks' || link.to_task_id !== task.id) return false;
    const blocker = taskById.get(link.from_task_id);
    return !!blocker && blocker.status !== 'done';
  });
}

export function isReady(task: Task, links: TaskLink[], tasks: Task[], nowIso: string): boolean {
  if (task.status !== 'pending') return false;
  if (isDeferred(task, nowIso)) return false;
  if (hasActiveBlocker(task, links, tasks)) return false;
  return true;
}

export function isFocused(task: Pick<Task, 'focused_until'>, nowIso: string): boolean {
  return !!task.focused_until && task.focused_until > nowIso;
}

export function readinessScore(
  task: Task,
  nowIso: string,
  links: TaskLink[] = [],
  tasks: Task[] = [],
): number {
  if (task.status === 'done') return 0;
  if (hasActiveBlocker(task, links, tasks)) return 5;

  const nowMs = new Date(nowIso).getTime();
  let score = 10;
  if (task.kickoff_note) score += 20;
  if (task.session_log) score += 15;
  if (isFocused(task, nowIso)) score += 12;
  if (nowMs - new Date(task.updated_at).getTime() < 14 * 86_400_000) score += 8;
  if (task.due_date) {
    // due_date is a UTC instant (Decision 4) — the window compares instants,
    // not calendar days. "Due soon" is an approximate same-day proxy, not an
    // exact overdue/today/later split.
    const dueMs = new Date(task.due_date).getTime();
    if (dueMs < nowMs) score += 10;
    else if (dueMs < nowMs + 86_400_000) score += 7;
    else if (dueMs <= nowMs + 7 * 86_400_000) score += 3;
  }
  return score;
}
