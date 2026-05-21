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

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  function visit(taskId: string): string[] | null {
    if (visiting.has(taskId)) {
      const cycleStart = stack.indexOf(taskId);
      return [...stack.slice(cycleStart), taskId];
    }
    if (visited.has(taskId)) return null;

    visiting.add(taskId);
    stack.push(taskId);

    for (const next of adjacency.get(taskId) ?? []) {
      const cycle = visit(next);
      if (cycle) return cycle;
    }

    stack.pop();
    visiting.delete(taskId);
    visited.add(taskId);
    return null;
  }

  for (const taskId of adjacency.keys()) {
    const cycle = visit(taskId);
    if (cycle) return cycle;
  }

  return null;
}
