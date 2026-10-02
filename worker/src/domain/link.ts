import type { LinkType, TaskId } from '../parse';
import { parseLinkType, parseTaskId, type ValidationError } from '../parse';
import { err, ok, type Result } from '@shared/result';

export interface TaskLinkDomain {
  from: TaskId;
  to: TaskId;
  linkType: LinkType;
}

export interface TaskLinkLike {
  from_task_id: string;
  to_task_id: string;
  link_type: string;
}

function withPath(path: string, errors: ValidationError[]): ValidationError[] {
  return errors.map(error => ({ ...error, path: [path, ...error.path] }));
}

export function taskLinkFromParts(
  fromTaskId: string,
  toTaskId: string,
  linkType: string,
): Result<TaskLinkDomain, ValidationError[]> {
  const errors: ValidationError[] = [];

  const from = parseTaskId(fromTaskId);
  if (!from.ok) errors.push(...withPath('from_task_id', from.error));

  const to = parseTaskId(toTaskId);
  if (!to.ok) errors.push(...withPath('to_task_id', to.error));

  const parsedLinkType = parseLinkType(linkType);
  if (!parsedLinkType.ok) errors.push(...withPath('link_type', parsedLinkType.error));

  if (!from.ok || !to.ok || !parsedLinkType.ok || errors.length > 0) return err(errors);
  return ok({ from: from.value, to: to.value, linkType: parsedLinkType.value });
}

export function findBlocksCycle(links: readonly TaskLinkLike[]): string[] | null {
  const adjacency = new Map<string, string[]>();
  for (const link of links) {
    if (link.link_type !== 'blocks') continue;
    const targets = adjacency.get(link.from_task_id) ?? [];
    targets.push(link.to_task_id);
    adjacency.set(link.from_task_id, targets);
  }

  // Iterative DFS: v1 imports and v2 restores are unbounded inputs, so recursion depth must not scale with chain length.
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  for (const root of adjacency.keys()) {
    if (visited.has(root)) continue;
    const frames: { id: string; next: number }[] = [{ id: root, next: 0 }];
    visiting.add(root);
    stack.push(root);
    while (frames.length > 0) {
      const frame = frames[frames.length - 1]!;
      const targets = adjacency.get(frame.id) ?? [];
      if (frame.next >= targets.length) {
        frames.pop();
        stack.pop();
        visiting.delete(frame.id);
        visited.add(frame.id);
        continue;
      }
      const target = targets[frame.next++]!;
      if (visiting.has(target)) return [...stack.slice(stack.indexOf(target)), target];
      if (visited.has(target)) continue;
      visiting.add(target);
      stack.push(target);
      frames.push({ id: target, next: 0 });
    }
  }

  return null;
}
