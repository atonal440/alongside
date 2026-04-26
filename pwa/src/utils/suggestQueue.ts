import type { Task, TaskLink } from '@shared/types';
import { isBlocked } from './design';

function isFocused(task: Task): boolean {
  return !!task.focused_until && task.focused_until > new Date().toISOString();
}

export function suggestQueue(tasks: Task[], today: string, cardSeen: Set<string>, links: TaskLink[] = []): Task[] {
  const now = new Date().toISOString();
  const candidates = tasks.filter(t =>
    t.status !== 'done' &&
    !(t.snoozed_until && t.snoozed_until > now) &&
    !isBlocked(t, links, tasks) &&
    !cardSeen.has(t.id),
  );

  const focused = candidates.filter(isFocused);
  const overdue = candidates
    .filter(t => !isFocused(t) && t.status === 'pending' && t.due_date !== null && t.due_date <= today)
    .sort((a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? ''));
  const ready = candidates.filter(t =>
    !isFocused(t) && t.status === 'pending' && t.kickoff_note && (!t.due_date || t.due_date > today),
  );
  const rest = candidates
    .filter(t => !isFocused(t) && t.status === 'pending' && !t.kickoff_note && (!t.due_date || t.due_date > today))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));

  return [...focused, ...overdue, ...ready, ...rest];
}
