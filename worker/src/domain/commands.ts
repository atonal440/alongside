import { parseRevision, type EventInstant } from '@shared/parse';
import type { CommandEnvelope, ChangesResult } from '@shared/wire/commands';
import type { FoundationErrorDetail, PlanningSettings } from '@shared/wire/planning';
import type { Plan } from './Op';

export class CommandError extends Error {
  constructor(readonly detail: FoundationErrorDetail, readonly status: number = 409) { super(detail.message); }
}
export function revisionConflict(expected: CommandEnvelope['commands'][number]['expectedRevision'], current: PlanningSettings | null): CommandError {
  return new CommandError({ code: 'revision_conflict', path: ['commands', '0', 'expectedRevision'],
    message: 'Planning settings changed since the supplied revision.', retryable: false,
    recoveryHint: 'Retain the intended settings, inspect currentSettings and submit a new command ID after rebasing.',
    expectedRevision: expected, currentSettings: current,
  });
}
export function payloadConflict(): CommandError {
  return new CommandError({ code: 'command_id_conflict', path: ['commandId'],
    message: 'This command ID was already used with a different payload.', retryable: false,
    recoveryHint: 'Replay the original payload or mint a new command ID for a different intention.',
  });
}
// Normalize semantic ordering before hashing. Object key order never changes
// replay identity; omitted optional fields remain omitted rather than null.
export function normalizeCommand(input: CommandEnvelope): CommandEnvelope {
  return { ...input, commands: input.commands.map(command => ({ ...command, values: {
    ...command.values, workingHours: [...command.values.workingHours].sort((a, b) => a.weekday - b.weekday || a.start.localeCompare(b.start)),
  } })) };
}
export function canonicalJson(input: unknown): string {
  if (Array.isArray(input)) return `[${input.map(canonicalJson).join(',')}]`;
  if (input !== null && typeof input === 'object') {
    return `{${Object.entries(input).filter(([, value]) => value !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, value]) => `${JSON.stringify(key)}:${canonicalJson(value)}`).join(',')}}`;
  }
  return JSON.stringify(input);
}
export async function commandHash(input: CommandEnvelope): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(normalizeCommand(input)));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}
export function planSettingsCommand(input: CommandEnvelope, before: PlanningSettings | null, hash: string, now: EventInstant): { plan: Plan; result: ChangesResult } {
  const command = normalizeCommand(input).commands[0]!;
  if (command.expectedRevision !== (before?.revision ?? null)) throw revisionConflict(command.expectedRevision, before);
  const nextRevision = parseRevision((before?.revision ?? 0) + 1);
  if (!nextRevision.ok) throw new CommandError({ code: 'revision_exhausted', path: ['commands', '0', 'expectedRevision'], message: 'Planning revision reached its supported limit.', retryable: false, recoveryHint: 'Contact the administrator; do not reset the revision.' });
  const after: PlanningSettings = { ...command.values, revision: nextRevision.value };
  const result: ChangesResult = { contractVersion: 2, commandId: input.commandId, payloadHash: hash,
    serverNow: now, applied: true, changes: [{ entity: 'planning_settings', id: 'workspace', before, after }], warnings: [], refs: {},
  };
  return { result, plan: {
    assertions: [{ kind: 'planning.revision', expected: command.expectedRevision }],
    ops: [{ kind: 'receipt.insert', result }, { kind: 'planning.replace', settings: after, now },
      { kind: 'command.audit', commandId: input.commandId, actor: input.actor, reason: input.reason ?? null, result }, { kind: 'command.feed', result }],
  } };
}
