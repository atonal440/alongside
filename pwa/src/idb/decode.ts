import type { Project, Task, TaskLink } from '@shared/types';
import type { ValidationError } from '@shared/parse';
import { parseTaskRow, parseProjectRow, parseTaskLinkRow } from '@shared/wire/rows';
import { migrateLegacyDeferShape } from './db';

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
      if (migrateLegacyDeferShape(mutable)) {
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

  for (const item of raw) {
    const key = item !== null && typeof item === 'object' && !Array.isArray(item)
      ? (item as Record<string, unknown>)['id'] ?? item
      : item;

    const parsed = parseProjectRow(item);
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
