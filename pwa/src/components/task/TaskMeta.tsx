import type { Task } from '../../types';

interface Props {
  task: Task;
  today: string;
}

export function taskMetaString(task: Task, today: string): string {
  const parts: string[] = [];
  if (task.due_date) {
    if (task.due_date < today) parts.push(`Overdue · ${task.due_date}`);
    else if (task.due_date === today) parts.push('Due today');
    else parts.push(task.due_date);
  }
  if (task.duty_id) parts.push('Duty');
  return parts.join(' · ');
}

export function TaskMeta({ task, today }: Props) {
  const meta = taskMetaString(task, today);
  if (!meta) return null;
  return <div className="cc-meta">{meta}</div>;
}
