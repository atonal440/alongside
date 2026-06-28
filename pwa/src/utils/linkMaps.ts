import type { TaskLink } from '@shared/types';

export function buildBlocksMap(links: TaskLink[]): Record<string, Set<string>> {
  const map: Record<string, Set<string>> = {};
  for (const link of links) {
    if (link.link_type !== 'blocks') continue;
    (map[link.from_task_id] ??= new Set<string>()).add(link.to_task_id);
  }
  return map;
}

export function buildBlockedByMap(links: TaskLink[]): Record<string, Set<string>> {
  const map: Record<string, Set<string>> = {};
  for (const link of links) {
    if (link.link_type !== 'blocks') continue;
    (map[link.to_task_id] ??= new Set<string>()).add(link.from_task_id);
  }
  return map;
}
