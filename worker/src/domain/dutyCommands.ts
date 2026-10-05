import { parseRevision, type EventInstant } from '@shared/parse';
import type { ChangesResult, CommandEnvelope } from '@shared/wire/commands';
import type { EntitySnapshot } from '@shared/wire/versions';
import type { Duty } from '@shared/types';
import { DutyRowSchema } from '@shared/wire/rows';
import { parseSchema } from '@shared/parse';
import { nextOccurrenceAfter, parseSeriesRrule } from '@shared/parse/recurrence';
import { parseIsoDateTimeMinute } from '@shared/parse/primitives';
import { invalidInput } from './temporalFoundation';
import { CommandError, creationConflict, entityCommandConflict } from './commands';
import { dutyFromRow } from './duty';
import type { DutyRowPatch, Plan } from './Op';

type Command = CommandEnvelope['commands'][number];
type DutyCommand = Extract<Command, { kind: 'duty.create' | 'duty.content.set' | 'duty.status.set' }>;
type SelectedProject = NonNullable<Extract<Command, { kind: 'duty.create' }>['values']['project']>;
export const isDutyCommand = (command: Command): command is DutyCommand => command.kind.startsWith('duty.');

const exhausted = (path: string[]) => new CommandError({ code: 'revision_exhausted', path, message: 'Entity or workspace revision reached its supported limit.',
  retryable: false, recoveryHint: 'Contact the administrator; do not reset a revision.' });

/** The row the command would store, as a wire row, after the series invariants hold. */
function validRow(candidate: unknown, path: string[]) {
  const row = parseSchema(DutyRowSchema, candidate);
  if (!row.ok) throw new CommandError(invalidInput(row.error.map(issue => ({ ...issue, path: [...path, ...issue.path] }))), 400);
  const series = dutyFromRow(row.value as Duty);
  if (!series.ok) throw new CommandError(invalidInput(series.error.map(issue => ({ ...issue, path: [...path, ...issue.path] }))), 400);
  return row.value;
}

/** The project a duty's template names must exist at the revision the caller saw. */
function projectAssertions(project: EntitySnapshot | null, selected: SelectedProject | null, path: string[]): Plan['assertions'] {
  if (selected === null) return [];
  if (project?.entity !== 'project' || project.id !== selected.id) throw new Error('Project snapshot identity mismatch.');
  if (project.row === null || project.version?.revision !== selected.expectedRevision) throw new CommandError({ code: 'revision_conflict', path,
    message: 'The selected project is missing or changed.', retryable: false, currentEntity: project, expectedRevision: selected.expectedRevision,
    recoveryHint: 'Retain the proposed duty, inspect the project and submit a fresh command ID after rebasing.',
  });
  return [{ kind: 'entity.revision', key: { entity: 'project', id: selected.id }, expected: selected.expectedRevision }, { kind: 'project.exists', id: selected.id }];
}

export function planDutyCommand(input: CommandEnvelope, current: EntitySnapshot, project: EntitySnapshot | null, hash: string, now: EventInstant): { plan: Plan; result: ChangesResult } {
  const command = input.commands[0]!;
  if (!isDutyCommand(command) || current.entity !== 'duty' || current.id !== command.id) throw new Error('Duty snapshot identity mismatch.');
  const bookkeeping = (result: ChangesResult): Plan['ops'] => [{ kind: 'receipt.insert', result },
    { kind: 'command.audit', commandId: input.commandId, actor: input.actor, reason: input.reason ?? null, result }, { kind: 'command.feed', result }];
  const key = { entity: 'duty' as const, id: current.id };

  if (command.kind === 'duty.create') {
    const conflict = creationConflict(input, current);
    if (conflict) throw conflict;
    if (!parseRevision(current.structuralRevision + 1).ok) throw exhausted(['commands', '0', 'expectedStructuralRevision']);
    const rev = parseRevision(1);
    if (!rev.ok) throw new Error('Invalid initial revision.');
    const { schedule, project: selected, title, notes, kickoffNote, taskType, catchUp } = command.values;
    const rule = parseSeriesRrule(schedule.rrule);
    if (!rule.ok) throw new CommandError(invalidInput(rule.error), 400);
    const start = parseIsoDateTimeMinute(schedule.dtstart);
    if (!start.ok) throw new CommandError(invalidInput(start.error), 400);
    let first: string | null;
    try { first = nextOccurrenceAfter(rule.value.parts, start.value, schedule.timezone, null); }
    catch (cause) { throw new CommandError(invalidInput([{ path: ['commands', '0', 'values', 'schedule'], code: 'series_search', message: cause instanceof Error ? cause.message : 'The schedule could not be expanded.' }]), 400); }
    if (first === null) throw new CommandError(invalidInput([{ path: ['commands', '0', 'values', 'schedule', 'rrule'], code: 'empty_series', message: 'The schedule has no occurrence at or after its start.' }]), 400);
    const row = validRow({ id: command.id, title, notes, kickoff_note: kickoffNote, task_type: taskType, project_id: selected?.id ?? null,
      rrule: schedule.rrule, dtstart: schedule.dtstart, timezone: schedule.timezone, status: 'active', catch_up: catchUp,
      last_spawned_at: null, next_occurrence_at: first, created_at: now, updated_at: now }, ['commands', '0', 'values']);
    const assertions: Plan['assertions'] = [{ kind: 'entity.revision', key, expected: null },
      { kind: 'workspace.structural_revision', expected: command.expectedStructuralRevision },
      ...projectAssertions(project, selected, ['commands', '0', 'values', 'project'])];
    const result: ChangesResult = { contractVersion: 2, commandId: input.commandId, payloadHash: hash, serverNow: now, applied: true,
      changes: [{ entity: 'duty', id: command.id, before: null, after: { revision: rev.value, row } }], warnings: [],
      refs: command.clientRef === undefined ? {} : { [command.clientRef]: command.id } };
    return { result, plan: { assertions, ops: [{ kind: 'receipt.insert', result }, { kind: 'duty.insert', row }, ...bookkeeping(result).slice(1)] } };
  }

  const conflict = entityCommandConflict(input, current);
  if (conflict) throw conflict;
  const before = current.row;
  if (before === null || current.version === null) throw new Error('Duty snapshot has no live row.');
  const next = parseRevision(current.version.revision + 1);
  if (!next.ok || !parseRevision(current.structuralRevision + 1).ok) throw exhausted(['commands', '0', 'expectedRevision']);
  const reject = (message: string): never => { throw new CommandError({ code: 'invalid_transition', path: ['commands', '0'], message, retryable: false, currentEntity: current,
    recoveryHint: 'Keep the intended change and inspect currentEntity before choosing a valid transition with a new command ID.' }); };
  let patch: DutyRowPatch;
  let assertions: Plan['assertions'] = [{ kind: 'entity.revision', key, expected: command.expectedRevision }];
  if (command.kind === 'duty.content.set') {
    const { title, notes, kickoffNote, taskType, project: selected, catchUp } = command.values;
    patch = { title, notes, kickoff_note: kickoffNote, task_type: taskType, project_id: selected?.id ?? null, catch_up: catchUp, updated_at: now };
    if (selected !== null && selected.id !== before.project_id) assertions = [...assertions, ...projectAssertions(project, selected, ['commands', '0', 'values', 'project'])];
  } else {
    if (before.status === 'ended') reject('An ended duty cannot change status; create a new duty to start the series again.');
    if (before.status === command.status) reject(`The duty is already ${command.status}.`);
    patch = command.status === 'ended' ? { status: 'ended', next_occurrence_at: null, updated_at: now } : { status: command.status, updated_at: now };
  }
  const row = validRow({ ...before, ...patch }, ['commands', '0']);
  const result: ChangesResult = { contractVersion: 2, commandId: input.commandId, payloadHash: hash, serverNow: now, applied: true,
    changes: [{ entity: 'duty', id: current.id, before: { revision: current.version.revision, row: before }, after: { revision: next.value, row } }], warnings: [], refs: {} };
  return { result, plan: { assertions, ops: [{ kind: 'receipt.insert', result }, { kind: 'duty.update', id: current.id, patch }, ...bookkeeping(result).slice(1)] } };
}
