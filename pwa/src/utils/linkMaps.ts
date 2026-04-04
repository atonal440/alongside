import type { TaskLink } from '@shared/types';

export function buildBlocksMap(links: TaskLink[]): Record<string, Set<string>> {
  const map: Record<string, Set<string>> = {};
  for (const link of links) {
    if (link.link_type !== 'blocks') continue;
    if (!map[link.from_task_id]) map[link.from_task_id] = new Set();
    map[link.from_task_id].add(link.to_task_id);
  }
  return map;
}

export function buildBlockedByMap(links: TaskLink[]): Record<string, Set<string>> {
  const map: Record<string, Set<string>> = {};
  for (const link of links) {
    if (link.link_type !== 'blocks') continue;
    if (!map[link.to_task_id]) map[link.to_task_id] = new Set();
    map[link.to_task_id].add(link.from_task_id);
  }
  return map;
}
