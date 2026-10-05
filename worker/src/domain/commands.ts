import { parseRevision, type EventInstant } from '@shared/parse';
import { MAX_TASK_DEPTH } from '@shared/hierarchy';
import type { CommandEnvelope, ChangesResult } from '@shared/wire/commands';
import type { FoundationErrorDetail, PlanningSettings } from '@shared/wire/planning';
import type { Plan, TaskRowPatch, ProjectRowPatch } from './Op';
import type { EntitySnapshot, EntityReadKey } from '@shared/wire/versions';
import { taskFromRow } from './task';
import { projectFromRow } from './project';
import { completeTaskPlan } from './ops/task';
import { parseIsoDateTime } from '@shared/parse';
import { invalidInput } from './temporalFoundation';
import { preferenceEntryFromParts } from './preference';
import { taskDateRoleProblem, temporalPointText } from '@shared/temporal';

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
/**
 * Replay identity for a tool call that compiles to commands: the tool name and its canonicalized
 * arguments, never the compiled envelope (which depends on live state). The `tool` key keeps these
 * hashes disjoint from envelope hashes.
 */
export async function toolRequestHash(tool: string, args: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson({ request: { tool, args } }));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}
/** What a preference currently holds: its value and sync revision, or nulls when no row exists. */
export interface PreferenceState { value: string | null; revision: number | null; nextRevision: number }
export function preferenceConflict(command: { key: string; expectedRevision: number | null }, current: PreferenceState): CommandError {
  return new CommandError({ code: 'revision_conflict', path: ['commands', '0', 'expectedRevision'],
    message: `Preference ${command.key} changed since the supplied revision.`, retryable: false, expectedRevision: command.expectedRevision as never,
    recoveryHint: 'Read the preference with get_context and submit a new command ID after rebasing.',
  });
}
export function planPreferenceCommand(input: CommandEnvelope, current: PreferenceState, hash: string, now: EventInstant): { plan: Plan; result: ChangesResult } {
  const command = input.commands[0]!;
  if (command.kind !== 'preference.set') throw new Error('Expected a preference.set command.');
  const entry = preferenceEntryFromParts(command.key, command.value);
  if (!entry.ok) throw new CommandError(invalidInput(entry.error.map(error => ({ ...error, path: ['commands', '0', ...error.path] }))), 400);
  if (command.expectedRevision !== current.revision) throw preferenceConflict(command, current);
  const next = parseRevision(current.nextRevision);
  if (!next.ok) throw new CommandError({ code: 'revision_exhausted', path: ['commands', '0', 'expectedRevision'], message: 'Preference revision reached its supported limit.', retryable: false, recoveryHint: 'Contact the administrator; do not reset the revision.' });
  const before = current.value === null || current.revision === null ? null : { revision: current.revision as never, value: current.value };
  const result: ChangesResult = { contractVersion: 2, commandId: input.commandId, payloadHash: hash, serverNow: now, applied: true,
    changes: [{ entity: 'preference', id: command.key, before, after: { revision: next.value, value: command.value } }], warnings: [], refs: {} };
  return { result, plan: { assertions: [{ kind: 'preference.revision', key: command.key, expected: current.revision as never }],
    ops: [{ kind: 'receipt.insert', result }, { kind: 'pref.upsert', entry: entry.value },
      { kind: 'command.audit', commandId: input.commandId, actor: input.actor, reason: input.reason ?? null, result }, { kind: 'command.feed', result }] } };
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
  if (command.kind !== 'task.create' && command.kind !== 'project.create') throw new Error('Expected a creation command.');
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
  if (command.kind !== 'task.create' && command.kind !== 'project.create') throw new Error('Expected a creation command.');
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
      session_log: null, focused_until: null, duty_id: null, occurrence_at: null, available_from: null, deadline: null, parent_id: null, position: null,
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

export function commandEntityKey(command: Exclude<CommandEnvelope['commands'][number], { kind: 'planning.set' | 'preference.set' | 'link.add' | 'link.remove' }>): EntityReadKey {
  switch (command.kind) {
    case 'task.delete': case 'task.create': case 'task.content.set': case 'task.focus.set': case 'task.defer.set': case 'task.reopen': case 'task.complete': case 'task.project.set': case 'task.parent.set': case 'task.type.set': case 'task.legacy-schedule.set': case 'task.dates.set': return { entity: 'task', id: command.id };
    case 'project.delete': case 'project.create': case 'project.content.set': case 'project.archive': case 'project.reopen': return { entity: 'project', id: command.id };
  }
}

export function entityCommandConflict(input: CommandEnvelope, current: EntitySnapshot): CommandError | null {
  const command = input.commands[0]!;
  if (command.kind === 'planning.set' || command.kind === 'preference.set' || command.kind === 'link.add' || command.kind === 'link.remove' || command.kind === 'task.create' || command.kind === 'project.create') throw new Error('Expected an existing-entity command.');
  return current.row !== null && current.version?.revision === command.expectedRevision ? null : new CommandError({
    code: 'revision_conflict', path: ['commands', '0', 'expectedRevision'], message: 'Entity changed or was deleted since planning.',
    retryable: false, currentEntity: current, expectedRevision: command.expectedRevision,
    recoveryHint: 'Retain the intended change, inspect currentEntity and submit a new command ID after explicitly rebasing.',
  });
}

export function planContentCommand(input: CommandEnvelope, current: EntitySnapshot, hash: string, now: EventInstant): { plan: Plan; result: ChangesResult } {
  const command = input.commands[0]!;
  if (command.kind !== 'task.content.set' && command.kind !== 'project.content.set') throw new Error('Expected a content command.');
  const conflict = entityCommandConflict(input, current);
  if (conflict) throw conflict;
  const common = { title: command.values.title, notes: command.values.notes, kickoff_note: command.values.kickoffNote, updated_at: now };
  return planEntityUpdate(input, current, command.kind === 'task.content.set'
    ? { entity: 'task', patch: { ...common, session_log: command.values.sessionLog } }
    : { entity: 'project', patch: common }, hash, now);
}

type EntityUpdate = { entity: 'task'; patch: TaskRowPatch } | { entity: 'project'; patch: ProjectRowPatch };
function planEntityUpdate(input: CommandEnvelope, current: EntitySnapshot, update: EntityUpdate, hash: string, now: EventInstant): { plan: Plan; result: ChangesResult } {
  const command = input.commands[0]!;
  if (command.kind === 'planning.set' || command.kind === 'preference.set' || command.kind === 'link.add' || command.kind === 'link.remove' || command.kind === 'task.create' || command.kind === 'project.create') throw new Error('Expected an existing-entity command.');
  if (current.id !== command.id || current.entity !== (command.kind.startsWith('task.') ? 'task' : 'project')) throw new Error('Update snapshot identity mismatch.');
  const conflict = entityCommandConflict(input, current);
  if (conflict) throw conflict;
  const next = parseRevision(current.version!.revision + 1);
  // A row write also advances the structural revision through its trigger.
  if (!next.ok || !parseRevision(current.structuralRevision + 1).ok) throw new CommandError({
    code: 'revision_exhausted', path: ['commands', '0', 'expectedRevision'], message: 'Entity or workspace revision reached its supported limit.',
    retryable: false, recoveryHint: 'Contact the administrator; do not reset a revision.',
  });
  let op: Plan['ops'][number];
  let change: ChangesResult['changes'][number];
  const identity: Extract<Plan['assertions'][number], { kind: 'entity.revision' }> = { kind: 'entity.revision', key: current.entity === 'task' ? { entity: 'task', id: current.id } : { entity: 'project', id: current.id }, expected: command.expectedRevision };
  if (current.entity === 'task' && update.entity === 'task') {
    const patch = update.patch;
    const row = { ...current.row!, ...patch };
    const parsed = taskFromRow(row);
    if (!parsed.ok) throw new CommandError(invalidInput(parsed.error), 400);
    op = { kind: 'task.update', id: current.id, patch };
    change = { entity: 'task', id: current.id, before: { row: current.row!, revision: current.version!.revision }, after: { row, revision: next.value } };
  } else if (current.entity === 'project' && update.entity === 'project') {
    const patch = update.patch;
    const row = { ...current.row!, ...patch };
    const parsed = projectFromRow(row);
    if (!parsed.ok) throw new CommandError(invalidInput(parsed.error), 400);
    op = { kind: 'project.update', id: current.id, patch };
    change = { entity: 'project', id: current.id, before: { row: current.row!, revision: current.version!.revision }, after: { row, revision: next.value } };
  } else throw new Error('Update patch entity mismatch.');
  const result: ChangesResult = { contractVersion: 2, commandId: input.commandId, payloadHash: hash, serverNow: now, applied: true,
    changes: [change], warnings: [], refs: {},
  };
  return { result, plan: { assertions: [identity], ops: [{ kind: 'receipt.insert', result }, op,
    { kind: 'command.audit', commandId: input.commandId, actor: input.actor, reason: input.reason ?? null, result }, { kind: 'command.feed', result }],
  } };
}

export function planStateCommand(input: CommandEnvelope, current: EntitySnapshot, hash: string, now: EventInstant): { plan: Plan; result: ChangesResult } {
  const command = input.commands[0]!;
  if (command.kind === 'planning.set' || command.kind === 'preference.set' || command.kind === 'link.add' || command.kind === 'link.remove' || command.kind === 'task.create' || command.kind === 'project.create') throw new Error('Expected a state command.');
  const conflict = entityCommandConflict(input, current);
  if (conflict) throw conflict;
  const reject = (message: string): never => { throw new CommandError({ code: 'invalid_transition', path: ['commands', '0'], message,
    retryable: false, currentEntity: current, recoveryHint: 'Keep the intended change and inspect currentEntity before choosing a valid transition with a new command ID.',
  }); };
  if (current.id !== command.id || current.entity !== commandEntityKey(command).entity) throw new Error('State snapshot identity mismatch.');
  if (current.entity === 'task') {
    let patch: TaskRowPatch = { updated_at: now };
    switch (command.kind) {
      case 'task.type.set':
        patch = { ...patch, task_type: command.taskType };
        break;
      case 'task.legacy-schedule.set':
        patch = { ...patch, due_date: command.values.dueDate, due_all_day: command.values.dueAllDay, recurrence: command.values.recurrence };
        break;
      case 'task.dates.set': {
        const problem = taskDateRoleProblem(command.values);
        if (problem) throw new CommandError(invalidInput([{ code: 'invalid_input', path: ['commands', '0', 'values', ...problem.path], message: problem.message }]), 400);
        patch = { ...patch, available_from: command.values.availableFrom === null ? null : temporalPointText(command.values.availableFrom),
          deadline: command.values.deadline === null ? null : temporalPointText(command.values.deadline) };
        break;
      }
      case 'task.focus.set':
        if (current.row!.status !== 'pending') reject('Only pending tasks can change focus.');
        patch = { ...patch, focused_until: command.focusedUntil,
          ...(command.focusedUntil === null ? {} : { defer_kind: 'none', defer_until: null }) };
        break;
      case 'task.defer.set':
        if (current.row!.status !== 'pending') reject('Only pending tasks can change deferral.');
        patch = { ...patch, defer_kind: command.defer.kind, defer_until: command.defer.kind === 'until' ? command.defer.until : null,
          ...(command.defer.kind === 'none' ? {} : { focused_until: null }) };
        break;
      case 'task.reopen':
        if (current.row!.status !== 'done' && current.row!.defer_kind === 'none') reject('Only done or deferred pending tasks can be reopened.');
        patch = { ...patch, status: 'pending', defer_kind: 'none', defer_until: null, focused_until: null };
        break;
      default: throw new Error('Expected a task state command.');
    }
    return planEntityUpdate(input, current, { entity: 'task', patch }, hash, now);
  } else {
    let patch: ProjectRowPatch = { updated_at: now };
    switch (command.kind) {
      case 'project.archive':
        if (current.row!.status !== 'active') reject('Only active projects can be archived.');
        patch = { ...patch, status: 'archived' };
        break;
      case 'project.reopen':
        if (current.row!.status !== 'archived') reject('Only archived projects can be reopened.');
        patch = { ...patch, status: 'active' };
        break;
      default: throw new Error('Expected a project state command.');
    }
    return planEntityUpdate(input, current, { entity: 'project', patch }, hash, now);
  }
}

export function planCompleteCommand(input: CommandEnvelope, current: EntitySnapshot, successor: EntitySnapshot | null, children: ChildState[], hash: string, now: EventInstant): { plan: Plan; result: ChangesResult } {
  const command = input.commands[0]!;
  if (command.kind !== 'task.complete' || current.entity !== 'task' || current.id !== command.id) throw new Error('Expected matching task completion.');
  const conflict = entityCommandConflict(input, current);
  if (conflict) throw conflict;
  if (current.structuralRevision !== command.expectedStructuralRevision) throw new CommandError({ code: 'structural_conflict',
    path: ['commands', '0', 'expectedStructuralRevision'], message: 'Workspace changed since planning completion.', retryable: false,
    currentEntity: current, expectedStructuralRevision: command.expectedStructuralRevision,
    recoveryHint: 'Retain completion intent, inspect current state and submit a fresh command ID after explicitly rebasing.',
  });
  const task = taskFromRow(current.row!);
  if (!task.ok) throw new CommandError(invalidInput(task.error), 400);
  if (task.value.lifecycle !== 'pending') throw new CommandError({ code: 'invalid_transition', path: ['commands', '0'], message: 'Only pending tasks can be completed.',
    retryable: false, currentEntity: current, recoveryHint: 'Inspect currentEntity; replay the original command if this is a retry.',
  });
  const open = children.filter(child => child.status === 'pending').length;
  if (open > 0) throw new CommandError({ code: 'invalid_transition', path: ['commands', '0'], message: `Complete the ${open} open subtask${open === 1 ? '' : 's'} first.`,
    retryable: false, currentEntity: current, recoveryHint: 'Complete or detach the open subtasks, then complete this task again with a new command ID.' });
  const recurring = task.value.recurrence.kind === 'recurring';
  if (recurring !== (command.successor !== null)) throw new CommandError({ code: 'invalid_input', path: ['commands', '0', 'successor'],
    message: recurring ? 'A legacy recurring completion requires a stable successor ID.' : 'A nonrecurring completion requires successor:null.',
    retryable: false, recoveryHint: 'Inspect the current recurrence and submit a complete intention with a fresh command ID.',
  }, 400);
  const next = parseRevision(current.version!.revision + 1);
  const structuralNext = parseRevision(current.structuralRevision + (recurring ? 2 : 1));
  if (!next.ok || !structuralNext.ok) throw new CommandError({ code: 'revision_exhausted', path: ['commands', '0', 'expectedRevision'],
    message: 'Entity or workspace revision reached its supported limit.', retryable: false, recoveryHint: 'Contact the administrator; do not reset a revision.',
  });
  const assertions: Plan['assertions'] = [
    { kind: 'entity.revision', key: { entity: 'task', id: command.id }, expected: command.expectedRevision },
    { kind: 'workspace.structural_revision', expected: command.expectedStructuralRevision },
  ];
  if (command.successor !== null) {
    if (successor?.entity !== 'task' || successor.id !== command.successor.id) throw new Error('Successor snapshot identity mismatch.');
    if (successor.row !== null || successor.version !== null) throw new CommandError({ code: 'revision_conflict', path: ['commands', '0', 'successor', 'id'],
      message: 'The successor identity already has live or deleted history.', retryable: false, currentEntity: successor, expectedRevision: null,
      recoveryHint: 'Retain completion intent and choose an unused stable successor ID with a new command ID.',
    });
    if (successor.structuralRevision !== current.structuralRevision) throw new CommandError({ code: 'structural_conflict', path: ['commands', '0', 'expectedStructuralRevision'],
      message: 'Workspace changed between completion reads.', retryable: false, currentEntity: successor, expectedStructuralRevision: command.expectedStructuralRevision,
      recoveryHint: 'Retain completion intent and inspect current state before explicitly rebasing with a new command ID.',
    });
    assertions.push({ kind: 'entity.revision', key: { entity: 'task', id: command.successor.id }, expected: null });
  }
  const clock = parseIsoDateTime(now);
  if (!clock.ok) throw new Error('Invalid completion event instant.');
  const planned = completeTaskPlan(task.value, { completedAt: clock.value, nextTaskId: command.successor?.id });
  if (!planned.ok) throw new Error('Completion planning failed after validating successor input.');
  const changes: ChangesResult['changes'] = [];
  for (const op of planned.value.ops) {
    if (op.kind === 'task.update') {
      const row = { ...current.row!, ...op.patch };
      const parsed = taskFromRow(row);
      if (!parsed.ok) throw new CommandError(invalidInput(parsed.error), 400);
      changes.push({ entity: 'task', id: command.id, before: { row: current.row!, revision: current.version!.revision }, after: { row, revision: next.value } });
    } else if (op.kind === 'task.insert' && command.successor !== null) {
      const parsed = taskFromRow(op.row);
      if (!parsed.ok) throw new CommandError(invalidInput(parsed.error), 400);
      const revision = parseRevision(1); if (!revision.ok) throw new Error('Invalid initial revision.');
      changes.push({ entity: 'task', id: command.successor.id, before: null, after: { row: op.row, revision: revision.value } });
    } else throw new Error('Unexpected completion operation.');
  }
  const result: ChangesResult = { contractVersion: 2, commandId: input.commandId, payloadHash: hash, serverNow: now, applied: true, changes, warnings: [],
    refs: command.successor?.clientRef === undefined ? {} : Object.fromEntries([[command.successor.clientRef, command.successor.id]]),
  };
  return { result, plan: { assertions, ops: [{ kind: 'receipt.insert', result }, ...planned.value.ops,
    { kind: 'command.audit', commandId: input.commandId, actor: input.actor, reason: input.reason ?? null, result }, { kind: 'command.feed', result }],
  } };
}

export { MAX_TASK_DEPTH };
/** A subtask as the hierarchy rules see it: identity and lifecycle only. */
export interface ChildState { id: string; status: string }

export function planTaskParentCommand(input: CommandEnvelope, current: EntitySnapshot, parent: EntitySnapshot | null, ancestors: EntitySnapshot[], hash: string, now: EventInstant): { plan: Plan; result: ChangesResult } {
  const command = input.commands[0]!;
  if (command.kind !== 'task.parent.set' || current.entity !== 'task' || current.id !== command.id) throw new Error('Expected matching task parent command.');
  const conflict = entityCommandConflict(input, current);
  if (conflict) throw conflict;
  if (current.structuralRevision !== command.expectedStructuralRevision) throw new CommandError({ code: 'structural_conflict', path: ['commands', '0', 'expectedStructuralRevision'],
    message: 'Workspace changed since planning the hierarchy.', retryable: false, currentEntity: current, expectedStructuralRevision: command.expectedStructuralRevision,
    recoveryHint: 'Retain the intended placement, inspect current state and submit a new command ID after explicitly rebasing.',
  });
  const reject = (message: string, hint: string, path: string[] = ['commands', '0', 'parent']): never => { throw new CommandError({ code: 'invalid_transition', path, message,
    retryable: false, currentEntity: current, recoveryHint: hint }); };
  const assertions: Plan['assertions'] = [{ kind: 'workspace.structural_revision', expected: command.expectedStructuralRevision }];
  if (command.parent !== null) {
    if (command.parent.id === command.id) reject('A task cannot be its own parent.', 'Choose a different parent.');
    if (parent?.entity !== 'task' || parent.id !== command.parent.id) throw new Error('Selected parent snapshot mismatch.');
    if (parent.row === null || parent.version?.revision !== command.parent.expectedRevision) throw new CommandError({ code: 'revision_conflict', path: ['commands', '0', 'parent'],
      message: 'Selected parent is missing or changed.', retryable: false, currentEntity: parent, expectedRevision: command.parent.expectedRevision,
      recoveryHint: 'Retain the placement intent and inspect the selected parent before explicitly rebasing with a new command ID.',
    });
    if (parent.structuralRevision !== current.structuralRevision) throw new CommandError({ code: 'structural_conflict', path: ['commands', '0', 'expectedStructuralRevision'],
      message: 'Workspace changed between hierarchy reads.', retryable: false, currentEntity: parent, expectedStructuralRevision: command.expectedStructuralRevision,
      recoveryHint: 'Retain the placement intent and preview again after explicitly rebasing with a new command ID.',
    });
    if ((parent.row.project_id ?? null) !== (current.row!.project_id ?? null)) reject('A subtask must be in the same project as its parent.',
      'Move the task into the parent\'s project first, or choose a parent in the task\'s project.');
    const chain = [parent, ...ancestors];
    if (chain.some(task => task.id === command.id)) reject('That placement would make the task its own ancestor.', 'Choose a parent outside this task\'s own subtasks.');
    if (chain.length + 1 > MAX_TASK_DEPTH) reject(`Tasks nest at most ${MAX_TASK_DEPTH} levels deep.`, 'Choose a shallower parent.');
    assertions.push({ kind: 'entity.revision', key: { entity: 'task', id: command.parent.id }, expected: command.parent.expectedRevision }, { kind: 'task.exists', id: command.parent.id });
  }
  const planned = planEntityUpdate(input, current, { entity: 'task', patch: { parent_id: command.parent?.id ?? null, position: command.parent === null ? null : command.position, updated_at: now } }, hash, now);
  return { result: planned.result, plan: { ...planned.plan, assertions: [...planned.plan.assertions, ...assertions] } };
}

export function planTaskProjectCommand(input: CommandEnvelope, current: EntitySnapshot, project: EntitySnapshot | null, children: ChildState[], hash: string, now: EventInstant): { plan: Plan; result: ChangesResult } {
  const command = input.commands[0]!;
  if (command.kind !== 'task.project.set' || current.entity !== 'task' || current.id !== command.id) throw new Error('Expected matching task project command.');
  const conflict = entityCommandConflict(input, current);
  if (conflict) throw conflict;
  if (current.structuralRevision !== command.expectedStructuralRevision) throw new CommandError({ code: 'structural_conflict', path: ['commands', '0', 'expectedStructuralRevision'],
    message: 'Workspace changed since planning membership.', retryable: false, currentEntity: current, expectedStructuralRevision: command.expectedStructuralRevision,
    recoveryHint: 'Retain the intended membership, inspect current state and submit a new command ID after explicitly rebasing.',
  });
  if (current.row!.parent_id !== null && current.row!.parent_id !== undefined) throw new CommandError({ code: 'invalid_transition', path: ['commands', '0', 'project'],
    message: 'A subtask stays in its parent\'s project.', retryable: false, currentEntity: current,
    recoveryHint: 'Make the task top level with task.parent.set first, or move the parent task instead.' });
  if (children.length > 0) throw new CommandError({ code: 'invalid_transition', path: ['commands', '0', 'project'],
    message: 'A task with subtasks cannot change project on its own.', retryable: false, currentEntity: current,
    recoveryHint: 'Detach or move its subtasks first; a hierarchy stays in one project.' });
  const assertions: Plan['assertions'] = [{ kind: 'workspace.structural_revision', expected: command.expectedStructuralRevision }];
  if (command.project !== null) {
    if (project?.entity !== 'project' || project.id !== command.project.id) throw new Error('Selected project snapshot mismatch.');
    if (project.row === null || project.version?.revision !== command.project.expectedRevision) throw new CommandError({ code: 'revision_conflict', path: ['commands', '0', 'project'],
      message: 'Selected project is missing or changed.', retryable: false, currentEntity: project, expectedRevision: command.project.expectedRevision,
      recoveryHint: 'Retain membership intent and inspect the selected project before explicitly rebasing with a new command ID.',
    });
    if (project.structuralRevision !== current.structuralRevision) throw new CommandError({ code: 'structural_conflict', path: ['commands', '0', 'expectedStructuralRevision'],
      message: 'Workspace changed between membership reads.', retryable: false, currentEntity: project, expectedStructuralRevision: command.expectedStructuralRevision,
      recoveryHint: 'Retain membership intent and preview again after explicitly rebasing with a new command ID.',
    });
    assertions.push({ kind: 'entity.revision', key: { entity: 'project', id: command.project.id }, expected: command.project.expectedRevision }, { kind: 'project.exists', id: command.project.id });
  }
  const planned = planEntityUpdate(input, current, { entity: 'task', patch: { project_id: command.project?.id ?? null, updated_at: now } }, hash, now);
  return { result: planned.result, plan: { ...planned.plan, assertions: [...planned.plan.assertions, ...assertions] } };
}
