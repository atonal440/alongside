import type { Task } from '../../types';
import { localDateOf } from '../../utils/design';

interface Props {
  task: Task;
  nowIso: string;
}

export function taskMetaString(task: Task, nowIso: string): string {
  const parts: string[] = [];
  if (task.due_date) {
    // Instant comparison first — mirrors formatDue (pwa/src/utils/design.ts):
    // a due_date with a real time-of-day must go overdue the moment it
    // passes, not stay "Due today" until local midnight.
    if (task.due_date < nowIso) parts.push(`Overdue · ${localDateOf(task.due_date)}`);
    else if (localDateOf(task.due_date) === localDateOf(nowIso)) parts.push('Due today');
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
