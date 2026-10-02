import type { Result } from '@shared/result';
import { err, ok } from '@shared/result';
import { parseRevision, type EventInstant, type ValidationError } from '@shared/parse';
import type { WorkspaceRestoreInput } from '@shared/wire/workspaceRestore';
import type { Plan } from './Op';
import type { AppError } from './errors';
import { validationErrorResult } from './errors';
import { findBlocksCycle } from './link';

const ATOMIC_STATEMENT_LIMIT = 100;
const RESTORE_FIXED_STATEMENTS = 9; // cursor guard, epoch advance, seven wipe deletes

function problem(path: string[], code: string, message: string): ValidationError {
  return { path, code, message };
}

/** Semantic checks the portable schema cannot express: duty occurrences and link graph shape. */
function restoreProblems(doc: WorkspaceRestoreInput['document']): ValidationError[] {
  const errors: ValidationError[] = [];
  const occurrences = new Map<string, number>();
  doc.tasks.forEach((task, index) => {
    if ((task.duty_id === null) !== (task.occurrence_at === null)) {
      errors.push(problem(['document', 'tasks', String(index), 'duty_id'], 'invalid_state', 'duty_id and occurrence_at must be set together.'));
    }
    if (task.duty_id !== null) {
      const key = `${task.duty_id}\u0000${task.occurrence_at}`;
      const first = occurrences.get(key);
      if (first !== undefined) errors.push(problem(['document', 'tasks', String(index), 'occurrence_at'], 'duplicate', `Duty occurrence duplicates tasks[${first}].`));
      else occurrences.set(key, index);
    }
  });
  doc.links.forEach((link, index) => {
    if (link.from_task_id === link.to_task_id) errors.push(problem(['document', 'links', String(index), 'to_task_id'], 'invalid_state', 'A task cannot be linked to itself.'));
  });
  const cycle = findBlocksCycle(doc.links);
  if (cycle) errors.push(problem(['document', 'links'], 'cycle', `Blocks links must be acyclic. Cycle: ${cycle.join(' -> ')}.`));
  return errors;
}

/**
 * One atomic replacement: cursor guard, epoch advance, wipe, then inserts in
 * dependency order. The epoch advances before any row write so every restore
 * feed event belongs to the new epoch and all older cursors must re-bootstrap.
 */
export function planWorkspaceRestore(
  input: WorkspaceRestoreInput, planningRevision: number, now: EventInstant,
): Result<Plan, AppError> {
  const doc = input.document;
  // Every row costs at least one statement, plus the guard, epoch advance and wipe. Reject by size
  // first so graph traversal never runs on documents that capacity would refuse anyway.
  const minimumStatements = RESTORE_FIXED_STATEMENTS + doc.tasks.length + doc.projects.length + doc.links.length
    + doc.duties.length + doc.preferences.length + doc.action_log.length;
  if (minimumStatements > ATOMIC_STATEMENT_LIMIT) return err({ kind: 'capacity_exceeded', requiredStatements: minimumStatements, limit: ATOMIC_STATEMENT_LIMIT });
  const errors = restoreProblems(doc);
  if (errors.length > 0) return err(validationErrorResult(errors));
  const settings = doc.planning_settings;
  const revision = parseRevision(planningRevision + 1);
  if (!revision.ok) return err({ kind: 'invariant_violation', message: 'Planning revision counter is exhausted.' });
  return ok({
    assertions: [{ kind: 'sync.cursor', epoch: input.expectedCursor.epoch, sequence: input.expectedCursor.sequence }],
    ops: [
      { kind: 'sync.epoch_advance' },
      { kind: 'workspace.wipe' },
      ...doc.projects.map(row => ({ kind: 'project.insert' as const, row })),
      ...doc.duties.map(row => ({ kind: 'duty.restore' as const, row })),
      ...doc.tasks.map(row => ({ kind: 'task.restore' as const, row })),
      ...doc.links.map(row => ({ kind: 'link.insert' as const, row })),
      ...doc.preferences.map(row => ({ kind: 'pref.restore' as const, key: row.key, value: row.value })),
      ...(settings === null ? [] : [{ kind: 'planning.replace' as const, now, settings: {
        timezone: settings.timezone, bufferMinutes: settings.bufferMinutes, workingHours: settings.workingHours,
        revision: revision.value } }]),
      ...doc.action_log.map(entry => ({ kind: 'log.restore' as const, entry })),
    ],
  });
}
