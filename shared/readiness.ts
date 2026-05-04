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

  const today = nowIso.slice(0, 10);
  let score = 10;
  if (task.kickoff_note) score += 20;
  if (task.session_log) score += 15;
  if (isFocused(task, nowIso)) score += 12;
  const age = Date.now() - new Date(task.updated_at).getTime();
  if (age < 14 * 86_400_000) score += 8;
  if (task.due_date) {
    if (task.due_date < today) score += 10;
    else if (task.due_date === today) score += 7;
    else if (task.due_date <= new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10)) score += 3;
  }
  return score;
}
