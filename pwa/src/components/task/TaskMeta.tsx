import type { Task } from '../../types';
import { deadlineBoundary, effectiveDates } from '@shared/readiness';
import { datePointLabel, dueDateLabel, localDateOf, localTimeOf } from '../../utils/design';

interface Props {
  task: Task;
  nowIso: string;
  tasks?: readonly Task[];
}

export function taskMetaString(task: Task, nowIso: string, tasks: readonly Task[] = []): string {
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
  // The hard deadline and earliest start are shown but not edited here yet; the target above is
  // still the date this form owns.
  const deadline = task.deadline ? datePointLabel(task.deadline) : '';
  if (deadline) {
    const boundary = deadlineBoundary(task);
    const passed = task.status !== 'done' && boundary !== null && Date.parse(boundary) < Date.parse(nowIso);
    parts.push(passed ? `Past deadline · ${deadline}` : `Deadline ${deadline}`);
  }
  // The opening that holds the task back may belong to an ancestor.
  const opening = effectiveDates(task, tasks).availableFrom;
  const openingSource = opening ? (opening.sourceId === task.id ? task : tasks.find(candidate => candidate.id === opening.sourceId)) : undefined;
  const opens = openingSource?.available_from ? datePointLabel(openingSource.available_from) : '';
  if (opens && opening && Date.parse(opening.at) > Date.parse(nowIso)) parts.push(openingSource === task ? `Starts ${opens}` : `Starts ${opens} (from "${openingSource!.title}")`);
  if (task.recurrence) parts.push('Recurring');
  return parts.join(' · ');
}

export function TaskMeta({ task, nowIso, tasks }: Props) {
  const meta = taskMetaString(task, nowIso, tasks);
  if (!meta) return null;
  return <div className="cc-meta">{meta}</div>;
}
