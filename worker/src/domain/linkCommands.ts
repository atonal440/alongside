import { parseRevision, type EventInstant } from '@shared/parse';
import { entityStorageKey, type LinkKey } from '@shared/wire/versions';
import type { CommandEnvelope, ChangesResult } from '@shared/wire/commands';
import type { Plan } from './Op';
import { CommandError } from './commands';
import type { LinkPlanningContext } from '../storage/link';
export function linkCommandKey(command: Extract<CommandEnvelope['commands'][number], { kind: 'link.add' | 'link.remove' }>): LinkKey {
  return { entity: 'link', from: command.from, to: command.to, linkType: command.linkType };
}
export function planLinkCommand(input: CommandEnvelope, context: LinkPlanningContext, hash: string, now: EventInstant): { plan: Plan; result: ChangesResult } {
  const command = input.commands[0]!;
  if (command.kind !== 'link.add' && command.kind !== 'link.remove') throw new Error('Expected link command.');
  const { current } = context; const key = linkCommandKey(command); const id = entityStorageKey(key);
  if (entityStorageKey(current.key) !== id) throw new Error('Link context key mismatch.');
  if ((current.version?.revision ?? null) !== command.expectedRevision) throw new CommandError({ code: 'revision_conflict', path: ['commands','0','expectedRevision'],
    message: 'Link changed since planning.', retryable: false, expectedRevision: command.expectedRevision, currentLink: current,
    recoveryHint: 'Retain link intent, inspect currentLink and submit a new command ID after explicitly rebasing.',
  });
  if (current.structuralRevision !== command.expectedStructuralRevision) throw new CommandError({ code: 'structural_conflict', path: ['commands','0','expectedStructuralRevision'],
    message: 'Workspace graph changed since planning.', retryable: false, currentLink: current, expectedStructuralRevision: command.expectedStructuralRevision,
    recoveryHint: 'Retain link intent and inspect current graph before explicitly rebasing with a new command ID.',
  });
  const invalid = (message: string): never => { throw new CommandError({ code: 'invalid_transition', path: ['commands','0'], message, retryable: false,
    currentLink: current, recoveryHint: 'Inspect currentLink/graph and choose a valid transition with a new command ID.',
  }); };
  if (command.kind === 'link.add') {
    if (current.row !== null) invalid('This link already exists.');
    if (!context.fromExists || !context.toExists) invalid('Both link endpoints must exist.');
    if (command.linkType === 'related' && context.reverse !== null) throw new CommandError({ code: 'invalid_transition', path: ['commands','0'],
      message: 'A reversed legacy related link already exists.', retryable: false, currentLink: context.reverse,
      recoveryHint: 'Retain intent; inspect and explicitly remove the reversed legacy identity before adding the canonical edge.',
    });
    if (context.wouldCycle) throw new CommandError({ code: 'graph_cycle', path: ['commands','0'], message: 'This blocks link would create a cycle.',
      retryable: false, currentLink: current, recoveryHint: 'Inspect dependencies and revise the intended edge with a new command ID.',
    });
  } else if (current.row === null) invalid('Only a live link can be removed.');
  const next = parseRevision((current.version?.revision ?? 0) + 1);
  if (!next.ok || !parseRevision(current.structuralRevision + 1).ok) throw new CommandError({ code: 'revision_exhausted', path: ['commands','0','expectedRevision'],
    message: 'Link or workspace revision reached its supported limit.', retryable: false, recoveryHint: 'Contact the administrator; do not reset a revision.',
  });
  const row = { from_task_id: command.from, to_task_id: command.to, link_type: command.linkType };
  const change: ChangesResult['changes'][number] = { entity: 'link', id,
    before: current.version === null ? null : { revision: current.version.revision, row: current.row },
    after: command.kind === 'link.add' ? { row, revision: next.value } : { deleted: true, revision: next.value },
  };
  const result: ChangesResult = { contractVersion: 2, commandId: input.commandId, payloadHash: hash, serverNow: now, applied: true, changes: [change], warnings: [], refs: {} };
  const assertions: Plan['assertions'] = [{ kind: 'entity.revision', key, expected: command.expectedRevision }, { kind: 'workspace.structural_revision', expected: command.expectedStructuralRevision }];
  if (command.kind === 'link.add') assertions.push({ kind: 'task.exists', id: command.from }, { kind: 'task.exists', id: command.to },
    ...(command.linkType === 'blocks' ? [{ kind: 'link.blocks_acyclic' as const, from: command.from, to: command.to }] : []));
  return { result, plan: { assertions, ops: [{ kind: 'receipt.insert', result },
    command.kind === 'link.add' ? { kind: 'link.insert', row } : { kind: 'link.delete', from: command.from, to: command.to, linkType: command.linkType },
    { kind: 'command.audit', commandId: input.commandId, actor: input.actor, reason: input.reason ?? null, result }, { kind: 'command.feed', result }],
  } };
}
