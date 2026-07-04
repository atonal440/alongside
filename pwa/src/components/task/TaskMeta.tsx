import type { Task } from '../../types';
import { dueDateLabel, localDateOf, localTimeOf } from '../../utils/design';

interface Props {
  task: Task;
  nowIso: string;
}

export function taskMetaString(task: Task, nowIso: string): string {
  const parts: string[] = [];
  if (task.due_date) {
    // Mirrors formatDue (pwa/src/utils/design.ts): an all-day due_date
    // stays "Due today" all day; a genuinely timed due_date goes overdue
    // the instant it passes and always shows its time (dueDateLabel), since
    // it's otherwise indistinguishable from an all-day task. due_all_day is
    // null on legacy rows — treated as all-day.
    const dueToday = localDateOf(task.due_date) === localDateOf(nowIso);
    const overdue = task.due_date < nowIso;
    const allDay = task.due_all_day ?? true;
    if (dueToday && (allDay || !overdue)) {
      parts.push(allDay ? 'Due today' : `Due today at ${localTimeOf(task.due_date)}`);
    } else if (overdue) {
      parts.push(`Overdue · ${dueDateLabel(task)}`);
    } else {
      parts.push(dueDateLabel(task));
    }
  }
  if (task.recurrence) parts.push('Recurring');
  return parts.join(' · ');
}

export function TaskMeta({ task, nowIso }: Props) {
  const meta = taskMetaString(task, nowIso);
  if (!meta) return null;
  return <div className="cc-meta">{meta}</div>;
}
