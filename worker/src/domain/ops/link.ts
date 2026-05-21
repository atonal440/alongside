import type { Result } from '@shared/result';
import { err, ok } from '@shared/result';
import type { AppError } from '../errors';
import { validationErrorResult } from '../errors';
import type { Plan } from '../Op';
import type { TaskLinkDomain } from '../link';

export type LinkPlanResult = Result<Plan, AppError>;

export interface LinkPlanner {
  linkTasksPlan(link: TaskLinkDomain): LinkPlanResult;
}

function selfLinkError(): AppError {
  return validationErrorResult([{
    path: ['to_task_id'],
    code: 'invalid_state',
    message: 'A task cannot be linked to itself.',
  }]);
}

export function linkTasksPlan(link: TaskLinkDomain): LinkPlanResult {
  if (link.from === link.to) return err(selfLinkError());

  return ok({
    assertions: [
      { kind: 'task.exists', id: link.from },
      { kind: 'task.exists', id: link.to },
      ...((link.linkType as string) === 'blocks'
        ? [{ kind: 'link.blocks_acyclic' as const, from: link.from, to: link.to }]
        : []),
    ],
    ops: [{
      kind: 'link.upsert',
      row: {
        from_task_id: link.from,
        to_task_id: link.to,
        link_type: link.linkType,
      },
    }],
  });
}

export function unlinkTasksPlan(link: TaskLinkDomain): LinkPlanResult {
  return ok({
    assertions: [],
    ops: [{
      kind: 'link.delete',
      from: link.from,
      to: link.to,
      linkType: link.linkType,
    }],
  });
}
