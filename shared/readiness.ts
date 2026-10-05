import type { Task, TaskLink } from './schema';
import { parseTemporalPointText, resolveDateBoundary } from './temporal';

export function isDeferred(task: Pick<Task, 'defer_kind' | 'defer_until'>, nowIso: string): boolean {
  if (task.defer_kind === 'someday') return true;
  if (task.defer_kind === 'until') {
    return !!task.defer_until && task.defer_until > nowIso;
  }
  return false;
}

/** The instant a stored date-role column resolves to, or null when unset or unreadable. */
function roleBoundaryMs(text: string | null, role: 'available_from' | 'deadline'): number | null {
  if (text === null) return null;
  const point = parseTemporalPointText(text);
  const boundary = point.ok ? resolveDateBoundary(point.value, role) : null;
  return boundary?.ok ? Date.parse(boundary.value.at) : null;
}

/** UTC instant (minute ISO text) at which the hard deadline passes, or null when none is set. */
export function deadlineBoundary(task: Pick<Task, 'deadline'>): string | null {
  const ms = roleBoundaryMs(task.deadline, 'deadline');
  return ms === null ? null : `${new Date(ms).toISOString().slice(0, 16)}:00Z`;
}

/** False while available_from is still in the future. A missing or unreadable value never blocks. */
export function isAvailable(task: Pick<Task, 'available_from'>, nowIso: string): boolean {
  const opens = roleBoundaryMs(task.available_from, 'available_from');
  return opens === null || opens <= new Date(nowIso).getTime();
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
  if (!isAvailable(task, nowIso)) return false;
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
  // Not yet available ranks with blocked work: it cannot be started now.
  if (hasActiveBlocker(task, links, tasks) || !isAvailable(task, nowIso)) return 5;

  const nowMs = new Date(nowIso).getTime();
  let score = 10;
  if (task.kickoff_note) score += 20;
  if (task.session_log) score += 15;
  if (isFocused(task, nowIso)) score += 12;
  if (nowMs - new Date(task.updated_at).getTime() < 14 * 86_400_000) score += 8;
  // The nearer of the target and the hard deadline sets the pressure; a hard deadline presses a
  // little harder than a target at the same distance. A date deadline's boundary is the end of
  // its local day, so a task due "today" still has time left until local midnight.
  const dueMs = task.due_date ? new Date(task.due_date).getTime() : null;
  const deadlineMs = roleBoundaryMs(task.deadline, 'deadline');
  let pressure = 0;
  if (dueMs !== null) {
    // due_date is a UTC instant (Decision 4) — the window compares instants,
    // not calendar days. "Due soon" is an approximate same-day proxy, not an
    // exact overdue/today/later split.
    if (dueMs < nowMs) pressure = 10;
    else if (dueMs < nowMs + 86_400_000) pressure = 7;
    else if (dueMs <= nowMs + 7 * 86_400_000) pressure = 3;
  }
  if (deadlineMs !== null) {
    if (deadlineMs < nowMs) pressure = Math.max(pressure, 12);
    else if (deadlineMs < nowMs + 86_400_000) pressure = Math.max(pressure, 9);
    else if (deadlineMs <= nowMs + 7 * 86_400_000) pressure = Math.max(pressure, 4);
  }
  score += pressure;
  return score;
}
