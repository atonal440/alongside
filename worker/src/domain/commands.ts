import { parseRevision, type EventInstant } from '@shared/parse';
import type { CommandEnvelope, ChangesResult } from '@shared/wire/commands';
import type { FoundationErrorDetail, PlanningSettings } from '@shared/wire/planning';
import type { Plan } from './Op';
import type { EntitySnapshot } from '@shared/wire/versions';

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
  return { ...input, commands: input.commands.map(command => command.kind !== 'planning.set' ? command : ({ ...command, values: {
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
  if (command.kind !== 'planning.set') throw new Error('Expected a planning.set command.');
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

export function creationConflict(input: CommandEnvelope, current: EntitySnapshot): CommandError | null {
  const command = input.commands[0]!;
  if (command.kind === 'planning.set') throw new Error('Expected a creation command.');
  if (current.version !== null || current.row !== null) return new CommandError({ code: 'revision_conflict', path: ['commands', '0', 'id'],
    message: 'This identity already has live or deleted history.', retryable: false, currentEntity: current, expectedRevision: null,
    recoveryHint: 'Replay the original command if this is a retry. For a different creation, keep intent and mint a new entity and command ID.',
  });
  if (current.structuralRevision !== command.expectedStructuralRevision) return new CommandError({ code: 'structural_conflict', path: ['commands', '0', 'expectedStructuralRevision'],
    message: 'Workspace structure changed since planning.', retryable: false, currentEntity: current, expectedStructuralRevision: command.expectedStructuralRevision,
    recoveryHint: 'Retain the proposed creation, inspect current state and submit a new command ID after rebasing.',
  });
  return null;
}

export function planCreateCommand(input: CommandEnvelope, current: EntitySnapshot, project: EntitySnapshot | null, hash: string, now: EventInstant): { plan: Plan; result: ChangesResult } {
  const command = input.commands[0]!;
  if (command.kind === 'planning.set') throw new Error('Expected a creation command.');
  if (current.entity !== (command.kind === 'task.create' ? 'task' : 'project') || current.id !== command.id) throw new Error('Creation snapshot identity mismatch.');
  const conflict = creationConflict(input, current);
  if (conflict) throw conflict;
  if (!parseRevision(current.structuralRevision + 1).ok) throw new CommandError({ code: 'revision_exhausted', path: ['commands', '0', 'expectedStructuralRevision'],
    message: 'Workspace structural revision reached its supported limit.', retryable: false, recoveryHint: 'Contact the administrator; do not reset the revision.',
  });
  const rev = parseRevision(1);
  if (!rev.ok) throw new Error('Invalid initial revision.');
  const assertions: Plan['assertions'] = [
    { kind: 'entity.revision', key: current.entity === 'task' ? { entity: 'task', id: current.id } : { entity: 'project', id: current.id }, expected: null },
    { kind: 'workspace.structural_revision', expected: command.expectedStructuralRevision },
  ];
  const values = command.values;
  const common = { title: values.title, notes: values.notes, kickoff_note: values.kickoffNote, created_at: now, updated_at: now };
  let mutation: Plan['ops'][number];
  let change: ChangesResult['changes'][number];
  if (command.kind === 'project.create') {
    const row = { ...common, id: command.id, status: 'active' as const };
    mutation = { kind: 'project.insert', row };
    change = { entity: 'project', id: command.id, before: null, after: { revision: rev.value, row } };
  } else {
    if (command.values.project !== null) {
      const selected = command.values.project;
      if (project?.entity !== 'project' || project.id !== selected.id) throw new Error('Project snapshot identity mismatch.');
      if (project.row === null || project.version?.revision !== selected.expectedRevision) throw new CommandError({ code: 'revision_conflict', path: ['commands', '0', 'values', 'project'],
        message: 'The selected project is missing or changed.', retryable: false, currentEntity: project, expectedRevision: selected.expectedRevision,
        recoveryHint: 'Retain the proposed task, inspect the project and submit a fresh command ID after rebasing.',
      });
      assertions.push({ kind: 'entity.revision', key: { entity: 'project', id: selected.id }, expected: selected.expectedRevision }, { kind: 'project.exists', id: selected.id });
    }
    const row = { ...common, id: command.id, task_type: command.values.taskType, project_id: command.values.project?.id ?? null,
      status: 'pending' as const, due_date: null, due_all_day: null, recurrence: null, defer_until: null, defer_kind: 'none' as const,
      session_log: null, focused_until: null, duty_id: null, occurrence_at: null,
    };
    mutation = { kind: 'task.insert', row };
    change = { entity: 'task', id: command.id, before: null, after: { revision: rev.value, row } };
  }
  const result: ChangesResult = { contractVersion: 2, commandId: input.commandId, payloadHash: hash, serverNow: now, applied: true,
    changes: [change], warnings: [], refs: command.clientRef === undefined ? {} : Object.fromEntries([[command.clientRef, command.id]]),
  };
  return { result, plan: { assertions, ops: [{ kind: 'receipt.insert', result }, mutation,
    { kind: 'command.audit', commandId: input.commandId, actor: input.actor, reason: input.reason ?? null, result }, { kind: 'command.feed', result }],
  } };
}
