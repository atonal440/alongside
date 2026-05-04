import type { Task, TaskLink } from '@shared/types';
import { isReady, readinessScore } from '@shared/readiness';

export function suggestQueue(tasks: Task[], _today: string, links: TaskLink[] = []): Task[] {
  const nowIso = new Date().toISOString();
  return tasks
    .filter(t => isReady(t, links, tasks, nowIso))
    .sort((a, b) => readinessScore(b, nowIso, links, tasks) - readinessScore(a, nowIso, links, tasks));
}
