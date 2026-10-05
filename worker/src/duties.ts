import type { Duty, Task } from '@shared/types';
import { parseIsoDateTimeMinute, type IsoDateTime } from '@shared/parse/primitives';
import { nanoid } from 'nanoid';
import { dutyFromRow } from './domain/duty';
import { adoptLegacyTaskPlan, materializeDutyPlan } from './domain/ops/duty';
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
  /** Legacy completion-recurring tasks moved onto the calendar engine this run. */
  adopted: number;
}

/** Legacy tasks examined per page and pages per run; each adoption is its own small atomic plan. */
const ADOPTIONS_PER_PAGE = 50;
const ADOPTION_PAGES = 5;

/**
 * Creates the instances every active duty owes at `at` and advances each cursor. Idempotent and safe to run
 * from several triggers at once: the due gate is a single indexed read, instance inserts conflict on
 * (duty, occurrence), and the cursor only moves forward. One duty's failure never blocks the others.
 */
export async function materializeDueDuties(d1: D1Database, at?: IsoDateTime): Promise<MaterializeSummary> {
  const summary: MaterializeSummary = { duties: 0, instances: 0, failed: 0, adopted: 0 };
  try {
    const now = at ?? minuteNow();
    await adoptLegacyRecurrence(d1, now, summary);
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

/**
 * Moves pending legacy completion-recurring tasks onto duties so the calendar engine is their only spawner.
 * Idempotent: the adoption is guarded on the task still being the unbound row it was planned from, and an
 * adopted task no longer carries a recurrence. Records the engine cannot represent are left on the legacy
 * completion path and reported, never half-converted.
 */
export async function adoptLegacyRecurrence(d1: D1Database, now: IsoDateTime, summary: MaterializeSummary): Promise<void> {
  // Keyset pages by id so tasks that cannot be adopted never crowd out adoptable ones behind them.
  let after = '';
  for (let page = 0; page < ADOPTION_PAGES; page += 1) {
    const legacy = await d1.prepare("SELECT * FROM tasks WHERE status='pending' AND recurrence IS NOT NULL AND duty_id IS NULL AND id > ? ORDER BY id LIMIT ?")
      .bind(after, ADOPTIONS_PER_PAGE).all<Task>();
    for (const task of legacy.results) {
      try {
        const adoption = adoptLegacyTaskPlan(task, now);
        if (!adoption.ok) { warnOnce(task.id, `legacy recurring task ${task.id} stays on the completion path: ${adoption.error}`); continue; }
        const applied = await applyPlan(d1, adoption.value.plan);
        if (!applied.ok) { summary.failed += 1; console.error(`legacy recurring task ${task.id} was not adopted: ${applied.error.kind}`); continue; }
        summary.adopted += 1;
        if (adoption.value.offCalendar) console.warn(`legacy recurring task ${task.id} was off its calendar; kept as a one-off and the series starts at its next occurrence`);
      } catch (cause) {
        summary.failed += 1;
        console.error(`legacy recurring task ${task.id} threw while being adopted`, cause);
      }
    }
    const last = legacy.results[legacy.results.length - 1];
    if (legacy.results.length < ADOPTIONS_PER_PAGE || last === undefined) break;
    after = last.id;
  }
}

const warned = new Set<string>();
/** Unadoptable records are reported once per isolate, not on every lazy read. */
function warnOnce(id: string, message: string): void {
  if (warned.has(id)) return;
  warned.add(id);
  console.warn(message);
}
