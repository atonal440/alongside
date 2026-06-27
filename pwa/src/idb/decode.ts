import type { Project, Task, TaskLink } from '@shared/types';
import type { ValidationError } from '@shared/parse';
import { parseTaskRow, parseProjectRow, parseTaskLinkRow } from '@shared/wire/rows';
import { migrateLegacyDeferShape } from './db';

// Default any nullable task/project field that is completely absent to null so
// that rows written before a field was added survive schema evolution without
// being quarantined. Only run this if the initial parse failed — valid rows pass
// through without mutation.
const NULLABLE_TASK_FIELDS = [
  'notes', 'due_date', 'recurrence', 'defer_until', 'project_id',
  'kickoff_note', 'session_log', 'focused_until',
] as const;

const NULLABLE_PROJECT_FIELDS = ['notes', 'kickoff_note'] as const;

// Canonicalize enum values removed from D1 schema via worker migrations:
//   task_type 'recurring' → 'action'   (migration 002)
//   status 'snoozed' → 'pending'       (migration 004)
//   status 'active'  → 'pending'       (migration 005)
// IDB was never migrated in-band, so old synced rows may still carry these.
function migrateLegacyTaskEnums(value: Record<string, unknown>): boolean {
  let changed = false;
  if (value['task_type'] === 'recurring') {
    value['task_type'] = 'action';
    changed = true;
  }
  if (value['status'] === 'snoozed' || value['status'] === 'active') {
    value['status'] = 'pending';
    changed = true;
  }
  return changed;
}

function fillMissingNullableTaskFields(value: Record<string, unknown>): boolean {
  let changed = false;
  for (const field of NULLABLE_TASK_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      value[field] = null;
      changed = true;
    }
  }
  return changed;
}

function fillMissingNullableProjectFields(value: Record<string, unknown>): boolean {
  let changed = false;
  for (const field of NULLABLE_PROJECT_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(value, field)) {
      value[field] = null;
      changed = true;
    }
  }
  return changed;
}

export interface DecodeReport {
  repaired: number;
  quarantined: { store: string; key: unknown; issues: ValidationError[] }[];
}

let _onReport: ((report: DecodeReport) => void) | null = null;

export function onDecodeReport(fn: (report: DecodeReport) => void): void {
  _onReport = fn;
}

function emitReport(report: DecodeReport): void {
  if (report.repaired > 0 || report.quarantined.length > 0) {
    _onReport?.(report);
  }
}

// Cross-field checks mirroring taskFromRow in worker/src/domain/task.ts.
// These run after field-level parsing succeeds; violations quarantine (no canonical repair).
function taskCrossFieldIssues(task: Task): ValidationError[] {
  const issues: ValidationError[] = [];

  if (task.defer_kind === 'none' && task.defer_until !== null) {
    issues.push({ path: ['defer_until'], code: 'invalid_state', message: 'defer_until must be null when defer_kind is none.' });
  }
  if (task.defer_kind === 'someday' && task.defer_until !== null) {
    issues.push({ path: ['defer_until'], code: 'invalid_state', message: 'defer_until must be null when defer_kind is someday.' });
  }
  if (task.defer_kind === 'until' && task.defer_until === null) {
    issues.push({ path: ['defer_until'], code: 'required', message: 'defer_until is required when defer_kind is until.' });
  }
  if (task.recurrence !== null && task.due_date === null) {
    issues.push({ path: ['due_date'], code: 'required', message: 'due_date is required when recurrence is set.' });
  }
  if (task.status === 'done') {
    if (task.defer_kind !== 'none') {
      issues.push({ path: ['defer_kind'], code: 'invalid_state', message: 'Done tasks cannot be deferred.' });
    }
    if (task.focused_until !== null) {
      issues.push({ path: ['focused_until'], code: 'invalid_state', message: 'Done tasks cannot be focused.' });
    }
  }
  if (task.defer_kind !== 'none' && task.focused_until !== null) {
    issues.push({ path: ['focused_until'], code: 'invalid_state', message: 'focused_until must be null when a task is deferred.' });
  }

  return issues;
}

interface DecodeResult<T> {
  rows: T[];
  report: DecodeReport;
  repairedRows: T[];
}

export function decodeTaskRows(raw: unknown[], store = 'tasks'): DecodeResult<Task> {
  const rows: Task[] = [];
  const repairedRows: Task[] = [];
  const quarantined: DecodeReport['quarantined'] = [];
  let repairedCount = 0;

  for (const item of raw) {
    const key = item !== null && typeof item === 'object' && !Array.isArray(item)
      ? (item as Record<string, unknown>)['id'] ?? item
      : item;

    let parsed = parseTaskRow(item);
    let wasRepaired = false;

    if (!parsed.ok && item !== null && typeof item === 'object' && !Array.isArray(item)) {
      const mutable = { ...(item as Record<string, unknown>) };
      const a = migrateLegacyDeferShape(mutable);
      const b = fillMissingNullableTaskFields(mutable);
      const c = migrateLegacyTaskEnums(mutable);
      if (a || b || c) {
        const reparsed = parseTaskRow(mutable);
        if (reparsed.ok) {
          parsed = reparsed;
          wasRepaired = true;
        }
      }
    }

    if (!parsed.ok) {
      quarantined.push({ store, key, issues: parsed.error });
      continue;
    }

    const crossIssues = taskCrossFieldIssues(parsed.value);
    if (crossIssues.length > 0) {
      quarantined.push({ store, key, issues: crossIssues });
      continue;
    }

    rows.push(parsed.value);
    if (wasRepaired) {
      repairedCount++;
      repairedRows.push(parsed.value);
    }
  }

  const report: DecodeReport = { repaired: repairedCount, quarantined };
  emitReport(report);
  return { rows, report, repairedRows };
}

export function decodeProjectRows(raw: unknown[], store = 'projects'): DecodeResult<Project> {
  const rows: Project[] = [];
  const repairedRows: Project[] = [];
  const quarantined: DecodeReport['quarantined'] = [];
  let repairedCount = 0;

  for (const item of raw) {
    const key = item !== null && typeof item === 'object' && !Array.isArray(item)
      ? (item as Record<string, unknown>)['id'] ?? item
      : item;

    let parsed = parseProjectRow(item);
    let wasRepaired = false;

    if (!parsed.ok && item !== null && typeof item === 'object' && !Array.isArray(item)) {
      const mutable = { ...(item as Record<string, unknown>) };
      if (fillMissingNullableProjectFields(mutable)) {
        const reparsed = parseProjectRow(mutable);
        if (reparsed.ok) {
          parsed = reparsed;
          wasRepaired = true;
        }
      }
    }

    if (!parsed.ok) {
      quarantined.push({ store, key, issues: parsed.error });
      continue;
    }

    rows.push(parsed.value);
    if (wasRepaired) {
      repairedCount++;
      repairedRows.push(parsed.value);
    }
  }

  const report: DecodeReport = { repaired: repairedCount, quarantined };
  emitReport(report);
  return { rows, report, repairedRows };
}

export function decodeLinkRows(raw: unknown[], store = 'links'): DecodeResult<TaskLink> {
  const rows: TaskLink[] = [];
  const repairedRows: TaskLink[] = [];
  const quarantined: DecodeReport['quarantined'] = [];

  for (const item of raw) {
    let key: unknown = item;
    if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
      const r = item as Record<string, unknown>;
      key = [r['from_task_id'], r['to_task_id'], r['link_type']];
    }

    const parsed = parseTaskLinkRow(item);
    if (!parsed.ok) {
      quarantined.push({ store, key, issues: parsed.error });
      continue;
    }

    rows.push(parsed.value);
  }

  const report: DecodeReport = { repaired: 0, quarantined };
  emitReport(report);
  return { rows, report, repairedRows };
}
