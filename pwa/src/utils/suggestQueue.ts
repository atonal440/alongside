import type { Task, TaskLink } from '@shared/types';
import { isReady } from '@shared/readiness';

function isFocused(task: Task): boolean {
  return !!task.focused_until && task.focused_until > new Date().toISOString();
}

export function suggestQueue(tasks: Task[], today: string, links: TaskLink[] = []): Task[] {
  const now = new Date().toISOString();
  const candidates = tasks.filter(t => isReady(t, links, tasks, now));

  const focused = candidates.filter(isFocused);
  const overdue = candidates
    .filter(t => !isFocused(t) && t.due_date !== null && t.due_date <= today)
    .sort((a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? ''));
  const ready = candidates.filter(t =>
    !isFocused(t) && t.kickoff_note && (!t.due_date || t.due_date > today),
  );
  const rest = candidates
    .filter(t => !isFocused(t) && !t.kickoff_note && (!t.due_date || t.due_date > today))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));

  return [...focused, ...overdue, ...ready, ...rest];
}
