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

/** A task and its ancestors, nearest first, ending at the top-level task. Loop-safe and depth-bounded. */
function chainOf(task: Task, byId: ReadonlyMap<string, Task>): Task[] {
  const chain = [task];
  const seen = new Set([task.id]);
  for (let at = task.parent_id ? byId.get(task.parent_id) : undefined; at !== undefined && !seen.has(at.id) && chain.length <= 33; at = at.parent_id ? byId.get(at.parent_id) : undefined) {
    chain.push(at);
    seen.add(at.id);
  }
  return chain;
}

const minuteIso = (ms: number) => `${new Date(ms).toISOString().slice(0, 16)}:00Z`;

export interface EffectiveBoundary {
  /** UTC instant (minute ISO text) the boundary resolves to. */
  at: string;
  /** The task, itself or an ancestor, whose own date role sets it. */
  sourceId: string;
}
export interface EffectiveDates {
  /** The latest opening among the task and its ancestors. */
  availableFrom: EffectiveBoundary | null;
  /** The earliest hard deadline among the task and its ancestors. */
  deadline: EffectiveBoundary | null;
  /** True when availability does not open strictly before the deadline: infeasible, not corrupt. */
  windowEmpty: boolean;
}

/**
 * Hard date roles after inheritance: a subtask cannot start before any ancestor opens or finish
 * after any ancestor's deadline. Targets (due_date) are never inherited. Ties go to the nearest
 * task so the source is the one the user most plausibly set.
 */
export function effectiveDates(task: Task, tasks: readonly Task[]): EffectiveDates {
  let availableFrom: EffectiveBoundary | null = null;
  let deadline: EffectiveBoundary | null = null;
  const chain = task.parent_id ? chainOf(task, new Map(tasks.map(candidate => [candidate.id, candidate]))) : [task];
  for (const member of chain) {
    const opens = roleBoundaryMs(member.available_from, 'available_from');
    if (opens !== null && (availableFrom === null || opens > Date.parse(availableFrom.at))) availableFrom = { at: minuteIso(opens), sourceId: member.id };
    const closes = roleBoundaryMs(member.deadline, 'deadline');
    if (closes !== null && (deadline === null || closes < Date.parse(deadline.at))) deadline = { at: minuteIso(closes), sourceId: member.id };
  }
  const windowEmpty = availableFrom !== null && deadline !== null && Date.parse(availableFrom.at) >= Date.parse(deadline.at);
  return { availableFrom, deadline, windowEmpty };
}

/**
 * False while available_from is still in the future. A missing or unreadable value never blocks.
 * Pass the workspace's tasks to include ancestors' openings.
 */
export function isAvailable(task: Pick<Task, 'available_from'> & Partial<Task>, nowIso: string, tasks?: readonly Task[]): boolean {
  const opens = tasks !== undefined && task.id !== undefined
    ? (() => { const effective = effectiveDates(task as Task, tasks).availableFrom; return effective === null ? null : Date.parse(effective.at); })()
    : roleBoundaryMs(task.available_from, 'available_from');
  return opens === null || opens <= new Date(nowIso).getTime();
}

/** Unfinished prerequisites of a task, each with the ancestor whose prerequisite it is (absent for the task's own). */
function openPrerequisites(chain: readonly Task[], links: readonly TaskLink[], byId: ReadonlyMap<string, Task>): { taskId: string; via?: string }[] {
  const found: { taskId: string; via?: string }[] = [];
  chain.forEach((member, depth) => {
    for (const link of links) {
      if (link.link_type !== 'blocks' || link.to_task_id !== member.id) continue;
      const blocker = byId.get(link.from_task_id);
      if (blocker && blocker.status !== 'done') found.push(depth === 0 ? { taskId: blocker.id } : { taskId: blocker.id, via: member.id });
    }
  });
  return found;
}

/** True when the task, or an ancestor whose prerequisites apply to it, waits on an unfinished task. */
export function hasActiveBlocker(task: Pick<Task, 'id'> & Partial<Task>, links: TaskLink[], tasks: Task[]): boolean {
  const byId = new Map(tasks.map(candidate => [candidate.id, candidate]));
  const self = byId.get(task.id) ?? (task as Task);
  return openPrerequisites(chainOf(self, byId), links, byId).length > 0;
}

export type ReadinessReason =
  | { code: 'not_pending' }
  | { code: 'deferred'; until: string | null }
  | { code: 'not_yet_available'; opensAt: string; sourceId: string }
  | { code: 'blocked_by'; taskId: string; via?: string }
  | { code: 'ancestor_done'; taskId: string };
export type ReadinessWarning =
  | { code: 'empty_window'; availableFrom: EffectiveBoundary; deadline: EffectiveBoundary }
  | { code: 'deadline_passed'; at: string; sourceId: string }
  | { code: 'open_subtasks'; count: number };
export interface Readiness {
  ready: boolean;
  /** Why the task cannot be started now; empty exactly when ready. */
  reasons: ReadinessReason[];
  /** Things worth knowing that do not gate readiness. */
  warnings: ReadinessWarning[];
  effective: EffectiveDates;
}

/**
 * Whether a task can be started now, with a reason for every gate that is closed: status,
 * deferral, inherited availability, unfinished prerequisites (its own and its ancestors') and a
 * finished ancestor. Focus and priority never gate it.
 */
export function readiness(task: Task, links: readonly TaskLink[], tasks: readonly Task[], nowIso: string): Readiness {
  const byId = new Map(tasks.map(candidate => [candidate.id, candidate]));
  const chain = chainOf(task, byId);
  const effective = effectiveDates(task, tasks);
  const nowMs = new Date(nowIso).getTime();
  const reasons: ReadinessReason[] = [];
  if (task.status !== 'pending') reasons.push({ code: 'not_pending' });
  if (isDeferred(task, nowIso)) reasons.push({ code: 'deferred', until: task.defer_kind === 'until' ? task.defer_until : null });
  if (effective.availableFrom && Date.parse(effective.availableFrom.at) > nowMs) reasons.push({ code: 'not_yet_available', opensAt: effective.availableFrom.at, sourceId: effective.availableFrom.sourceId });
  for (const blocker of openPrerequisites(chain, links, byId)) reasons.push({ code: 'blocked_by', ...blocker });
  for (const ancestor of chain.slice(1)) if (ancestor.status === 'done') reasons.push({ code: 'ancestor_done', taskId: ancestor.id });
  const warnings: ReadinessWarning[] = [];
  if (effective.windowEmpty && effective.availableFrom && effective.deadline) warnings.push({ code: 'empty_window', availableFrom: effective.availableFrom, deadline: effective.deadline });
  if (task.status === 'pending' && effective.deadline && Date.parse(effective.deadline.at) < nowMs) warnings.push({ code: 'deadline_passed', at: effective.deadline.at, sourceId: effective.deadline.sourceId });
  const open = tasks.filter(candidate => candidate.parent_id === task.id && candidate.status === 'pending').length;
  if (open > 0) warnings.push({ code: 'open_subtasks', count: open });
  return { ready: reasons.length === 0, reasons, warnings, effective };
}

export function isReady(task: Task, links: TaskLink[], tasks: Task[], nowIso: string): boolean {
  return readiness(task, links, tasks, nowIso).ready;
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
  if (hasActiveBlocker(task, links, tasks) || !isAvailable(task, nowIso, tasks)) return 5;

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
  const inherited = effectiveDates(task, tasks).deadline;
  const deadlineMs = inherited ? Date.parse(inherited.at) : null;
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
