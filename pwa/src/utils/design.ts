import type { Project, Task, TaskLink } from '../types';
import { localParts, parseTemporalPointText } from '@shared/temporal';
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

export function localTimeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

// An all-day due_date never shows a time — its noon-UTC instant is a storage
// artifact (Decision 4), not intent, so `localDateOf` alone is the honest
// label. A genuinely timed one (due_all_day: false) is a real public part of
// the due-date contract now (REST/MCP can set a full datetime directly), so
// it must show the time too, or it's indistinguishable from an all-day task.
export function dueDateLabel(task: Pick<Task, 'due_date' | 'due_all_day'>): string {
  if (!task.due_date) return '';
  const date = localDateOf(task.due_date);
  return task.due_all_day === false ? `${date} at ${localTimeOf(task.due_date)}` : date;
}

// A date-role point (deadline / available_from) is shown in the zone it was entered in, as the
// plain date or as date and time; it is never reinterpreted in the viewer's zone because "Friday
// in Los Angeles" has to stay Friday.
export function datePointLabel(text: string): string {
  const point = parseTemporalPointText(text);
  if (!point.ok) return '';
  if (point.value.kind === 'date') return point.value.date;
  const { date, time } = localParts(Date.parse(point.value.at), point.value.timezone);
  return `${date} at ${time}`;
}

export function formatDue(task: Pick<Task, 'due_date' | 'due_all_day'>, nowIso: string): string {
  if (!task.due_date) return '';
  const dueToday = localDateOf(task.due_date) === localDateOf(nowIso);
  const overdue = task.due_date < nowIso;
  // due_all_day is null on legacy rows (predates the column) — treated as
  // all-day. An all-day due date stays "Due today" for the whole viewer-local
  // day even past its noon-UTC instant; a genuinely timed one goes overdue
  // the moment it passes, same local day or not.
  const allDay = task.due_all_day ?? true;
  if (dueToday && (allDay || !overdue)) {
    return allDay ? 'Due today' : `Due today at ${localTimeOf(task.due_date)}`;
  }
  if (overdue) return `Overdue ${dueDateLabel(task)}`;
  return `Due ${dueDateLabel(task)}`;
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
