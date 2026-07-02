import type { Project, Task, TaskLink } from '../types';
import {
  isDeferred as sharedIsDeferred,
  isFocused as sharedIsFocused,
  hasActiveBlocker,
  readinessScore as sharedReadinessScore,
} from '@shared/readiness';

const PROJECT_COLORS = ['#3A6280', '#4A7C5A', '#8B6BAE', '#9C8472', '#C0622A'];

export function isFocused(task: Pick<Task, 'focused_until'>, nowIso = new Date().toISOString()): boolean {
  return sharedIsFocused(task, nowIso);
}

export function isDeferred(task: Pick<Task, 'defer_kind' | 'defer_until'>, nowIso = new Date().toISOString()): boolean {
  return sharedIsDeferred(task, nowIso);
}

export function isSomeday(task: Pick<Task, 'defer_kind'>): boolean {
  return task.defer_kind === 'someday';
}

export function projectTitle(task: Task, projects: Project[]): string {
  if (!task.project_id) return 'No project';
  return projects.find(p => p.id === task.project_id)?.title ?? 'No project';
}

export function projectColor(projectId: string | null | undefined): string {
  if (!projectId) return '#9C8472';
  let hash = 0;
  for (let i = 0; i < projectId.length; i += 1) {
    hash = (hash * 31 + projectId.charCodeAt(i)) >>> 0;
  }
  return PROJECT_COLORS[hash % PROJECT_COLORS.length] ?? '#9C8472';
}

// due_date is a UTC instant (Decision 4). Displaying it as a plain date means
// reading its date part back in the viewer's local zone — not slicing the
// stored UTC string — so a noon-UTC all-day value (the migration convention)
// renders on the calendar day it was meant to represent. See
// docs/plans/duties/02-timestamp-model.md "Migrated" / "Presentation stays honest".
export function localDateOf(iso: string): string {
  return new Date(iso).toLocaleDateString('en-CA');
}

// Decision 4 has no explicit all-day flag by design (02-timestamp-model.md
// "Presentation stays honest" — a flag would reintroduce the date-only
// distinction it removes). Every all-day due_date — from the PWA's date-only
// picker, a bare-date REST/MCP write, or the migration — is anchored to
// exactly noon UTC, so that's the heuristic: treat it as "all-day due today"
// while it's still the viewer's local day, even past the noon-UTC instant.
// Any other time-of-day is a genuine timed due_date and goes overdue the
// moment it passes, same local day or not.
export function isAllDayDueDate(dueDate: string): boolean {
  return dueDate.endsWith('T12:00:00Z');
}

export function formatDue(task: Pick<Task, 'due_date'>, nowIso: string): string {
  if (!task.due_date) return '';
  const dueToday = localDateOf(task.due_date) === localDateOf(nowIso);
  const overdue = task.due_date < nowIso;
  if (dueToday && (isAllDayDueDate(task.due_date) || !overdue)) return 'Due today';
  if (overdue) return `Overdue ${localDateOf(task.due_date)}`;
  return `Due ${localDateOf(task.due_date)}`;
}

export function readinessScore(task: Task, links: TaskLink[] = [], tasks: Task[] = [], nowIso = new Date().toISOString()): number {
  return sharedReadinessScore(task, nowIso, links, tasks);
}

export function isBlocked(task: Task, links: TaskLink[], tasks: Task[] = []): boolean {
  if (tasks.length === 0) return links.some(l => l.link_type === 'blocks' && l.to_task_id === task.id);
  return hasActiveBlocker(task, links, tasks);
}

export function taskSort(a: Task, b: Task, links: TaskLink[], tasks: Task[] = [], nowIso = new Date().toISOString()): number {
  return readinessScore(b, links, tasks, nowIso) - readinessScore(a, links, tasks, nowIso)
    || (a.due_date ?? '9999-99-99').localeCompare(b.due_date ?? '9999-99-99')
    || a.title.localeCompare(b.title);
}

export function firstNoteEntry(notes: string | null): string {
  if (!notes) return '';
  return notes.split(/\n{2,}/)[0]?.trim() ?? '';
}
