import type { Project, Task, TaskLink } from '../types';
import {
  isDeferred as sharedIsDeferred,
  isFocused as sharedIsFocused,
  hasActiveBlocker,
  readinessScore as sharedReadinessScore,
} from '@shared/readiness';

const PROJECT_COLORS = ['#3A6280', '#4A7C5A', '#8B6BAE', '#9C8472', '#C0622A'];

export function isFocused(task: Pick<Task, 'focused_until'>): boolean {
  return sharedIsFocused(task, new Date().toISOString());
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
  return PROJECT_COLORS[hash % PROJECT_COLORS.length];
}

export function formatDue(task: Pick<Task, 'due_date'>, today: string): string {
  if (!task.due_date) return '';
  if (task.due_date < today) return `Overdue ${task.due_date}`;
  if (task.due_date === today) return 'Due today';
  return `Due ${task.due_date}`;
}

export function readinessScore(task: Task, _today: string, links: TaskLink[] = [], tasks: Task[] = []): number {
  return sharedReadinessScore(task, new Date().toISOString(), links, tasks);
}

export function isBlocked(task: Task, links: TaskLink[], tasks: Task[] = []): boolean {
  if (tasks.length === 0) return links.some(l => l.link_type === 'blocks' && l.to_task_id === task.id);
  return hasActiveBlocker(task, links, tasks);
}

export function taskSort(a: Task, b: Task, today: string, links: TaskLink[], tasks: Task[] = []): number {
  return readinessScore(b, today, links, tasks) - readinessScore(a, today, links, tasks)
    || (a.due_date ?? '9999-99-99').localeCompare(b.due_date ?? '9999-99-99')
    || a.title.localeCompare(b.title);
}

export function firstNoteEntry(notes: string | null): string {
  if (!notes) return '';
  return notes.split(/\n{2,}/)[0]?.trim() ?? '';
}
