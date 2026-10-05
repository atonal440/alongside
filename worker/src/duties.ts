import type { Duty } from '@shared/types';
import { parseIsoDateTimeMinute, type IsoDateTime } from '@shared/parse/primitives';
import { nanoid } from 'nanoid';
import { dutyFromRow } from './domain/duty';
import { materializeDutyPlan } from './domain/ops/duty';
import { applyPlan } from './storage';

/** Duties examined per page, most overdue first, so one run's work stays bounded. */
export const DUTIES_PER_RUN = 200;
/** Instances created per duty per run under `catch_up: 'all'`; keeps each plan under the batch statement cap. */
export const INSTANCES_PER_DUTY = 50;
/** Pages of `DUTIES_PER_RUN` examined per run. */
const MAX_PAGES = 5;

export interface MaterializeSummary {
  /** Duties whose plans were applied. */
  duties: number;
  /** Instances those plans tried to create (an already-materialized occurrence is a no-op). */
  instances: number;
  /** Duties skipped because their row or expansion failed; they stay due and are reported, not retried in the same run. */
  failed: number;
}

/**
 * Creates the instances every active duty owes at `at` and advances each cursor. Idempotent and safe to run
 * from several triggers at once: the due gate is a single indexed read, instance inserts conflict on
 * (duty, occurrence), and the cursor only moves forward. One duty's failure never blocks the others.
 */
export async function materializeDueDuties(d1: D1Database, at?: IsoDateTime): Promise<MaterializeSummary> {
  const summary: MaterializeSummary = { duties: 0, instances: 0, failed: 0 };
  try {
    const now = at ?? minuteNow();
    const gate = await d1.prepare("SELECT 1 AS due FROM duties WHERE status='active' AND next_occurrence_at IS NOT NULL AND next_occurrence_at <= ? LIMIT 1")
      .bind(now).first();
    if (gate === null) return summary;

    // Keyset pages, most overdue first. A duty that fails stays due, so paging past it keeps a few broken
    // rows from starving valid ones; MAX_PAGES bounds the work either way.
    let after: { next: string; id: string } | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const due: D1Result<Duty> = await d1.prepare(`SELECT * FROM duties WHERE status='active' AND next_occurrence_at IS NOT NULL AND next_occurrence_at <= ?
          ${after ? 'AND (next_occurrence_at > ? OR (next_occurrence_at = ? AND id > ?))' : ''} ORDER BY next_occurrence_at ASC, id ASC LIMIT ?`)
        .bind(...(after ? [now, after.next, after.next, after.id] : [now]), DUTIES_PER_RUN).all<Duty>();
      for (const row of due.results) await materializeOne(d1, row, now, summary);
      const last = due.results[due.results.length - 1];
      if (due.results.length < DUTIES_PER_RUN || last === undefined || last.next_occurrence_at === null) break;
      after = { next: last.next_occurrence_at, id: last.id };
    }
  } catch (cause) {
    // Lazy callers await this before ordinary reads; a failure here must not break them.
    summary.failed += 1;
    console.error('duty materialization failed', cause);
  }
  return summary;
}

async function materializeOne(d1: D1Database, row: Duty, now: IsoDateTime, summary: MaterializeSummary): Promise<void> {
  try {
    const series = dutyFromRow(row);
    if (!series.ok) { summary.failed += 1; console.error(`duty ${row.id} is invalid: ${series.error.map(issue => issue.message).join('; ')}`); return; }
    const prior = await d1.prepare("SELECT session_log FROM tasks WHERE duty_id = ? AND status = 'done' AND session_log IS NOT NULL ORDER BY occurrence_at DESC LIMIT 1")
      .bind(row.id).first<{ session_log: string }>();
    const plan = materializeDutyPlan(series.value, { now, priorSessionLog: prior?.session_log ?? null, mintTaskId: () => `t_${nanoid(5)}`, maxPerRun: INSTANCES_PER_DUTY });
    if (!plan.ok) { summary.failed += 1; console.error(`duty ${row.id} was not materialized: ${plan.error.kind}`); return; }
    if (plan.value.ops.length === 0) return;
    const applied = await applyPlan(d1, plan.value);
    if (!applied.ok) { summary.failed += 1; console.error(`duty ${row.id} plan failed: ${applied.error.kind}`); return; }
    summary.duties += 1;
    summary.instances += plan.value.ops.filter(op => op.kind === 'task.insert').length;
  } catch (cause) {
    summary.failed += 1;
    console.error(`duty ${row.id} threw while materializing`, cause);
  }
}

function minuteNow(): IsoDateTime {
  const parsed = parseIsoDateTimeMinute(new Date().toISOString());
  if (!parsed.ok) throw new Error('System clock produced an invalid timestamp.');
  return parsed.value;
}
