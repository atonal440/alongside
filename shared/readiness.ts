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
