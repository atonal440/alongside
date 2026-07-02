import type { Task } from '../../types';
import { isAllDayDueDate, localDateOf } from '../../utils/design';

interface Props {
  task: Task;
  nowIso: string;
}

export function taskMetaString(task: Task, nowIso: string): string {
  const parts: string[] = [];
  if (task.due_date) {
    // Mirrors formatDue (pwa/src/utils/design.ts): an all-day due_date
    // (noon-UTC anchor) stays "Due today" all day; a genuinely timed
    // due_date goes overdue the instant it passes.
    const dueToday = localDateOf(task.due_date) === localDateOf(nowIso);
    const overdue = task.due_date < nowIso;
    if (dueToday && (isAllDayDueDate(task.due_date) || !overdue)) parts.push('Due today');
    else if (overdue) parts.push(`Overdue · ${localDateOf(task.due_date)}`);
    else parts.push(localDateOf(task.due_date));
  }
  if (task.recurrence) parts.push('Recurring');
  return parts.join(' · ');
}

export function TaskMeta({ task, nowIso }: Props) {
  const meta = taskMetaString(task, nowIso);
  if (!meta) return null;
  return <div className="cc-meta">{meta}</div>;
}
