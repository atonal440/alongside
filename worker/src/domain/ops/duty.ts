import { err, ok, type Result } from '@shared/result';
import {
  isSeriesExhausted,
  latestOccurrenceAtOrBefore,
  nextOccurrenceAfter,
  occurrencesBetween,
} from '@shared/parse/recurrence';
import type { IsoDateTime } from '@shared/parse/primitives';
import type { DutySeries } from '../duty';
import type { AppError } from '../errors';
import { emptyPlan, type Op, type Plan, type TaskRow } from '../Op';

export interface MaterializeCtx {
  /** The current UTC instant: the upper bound for due occurrences and the spawn timestamp. */
  now: IsoDateTime;
  /** session_log of the duty's most recently completed instance, carried into the next kickoff note. */
  priorSessionLog: string | null;
  mintTaskId: () => string;
  /** Bounds the instances one run creates under `catch_up: 'all'`. */
  maxPerRun: number;
}

/** One instance of the duty's template, due at the occurrence and identified by (duty, occurrence). */
export function instanceFromTemplate(series: DutySeries, occurrenceAt: IsoDateTime, ctx: MaterializeCtx): TaskRow {
  const duty = series.row;
  return {
    id: ctx.mintTaskId(), title: duty.title, notes: duty.notes, status: 'pending',
    due_date: occurrenceAt, due_all_day: false, recurrence: null,
    created_at: ctx.now, updated_at: ctx.now,
    defer_until: null, defer_kind: 'none', task_type: duty.task_type, project_id: duty.project_id,
    kickoff_note: ctx.priorSessionLog ?? duty.kickoff_note, session_log: null, focused_until: null,
    duty_id: duty.id, occurrence_at: occurrenceAt,
    available_from: null, deadline: null, parent_id: null, position: null,
  };
}

/**
 * Brings one active duty up to `now`. `next` materializes only the newest due occurrence and jumps
 * the cursor to it, leaving older open instances untouched; `all` materializes the backlog oldest
 * first, at most `maxPerRun` per call, so the cursor only advances past what was created. A series
 * with nothing left becomes ended. Inserts precede the cursor update so one atomic batch carries both.
 */
export function materializeDutyPlan(series: DutySeries, ctx: MaterializeCtx): Result<Plan, AppError> {
  const duty = series.row;
  if (duty.status !== 'active') return ok(emptyPlan());
  const { parts, dtstart, timezone, cursor } = series;

  let spawn: IsoDateTime[];
  try {
    const latest = latestOccurrenceAtOrBefore(parts, dtstart, timezone, ctx.now);
    if (latest === null || (cursor !== null && Date.parse(latest) <= Date.parse(cursor))) {
      if (!isSeriesExhausted(parts, dtstart, timezone, cursor)) return ok(emptyPlan());
      return ok({ assertions: [{ kind: 'duty.exists', id: duty.id }], ops: [
        { kind: 'duty.update', id: duty.id, ifStatus: 'active', patch: { status: 'ended', next_occurrence_at: null, updated_at: ctx.now } },
      ] });
    }
    spawn = duty.catch_up === 'all'
      ? occurrencesBetween(parts, dtstart, timezone, cursor, ctx.now, ctx.maxPerRun)
      : [latest];
  } catch (cause) {
    return err({ kind: 'invariant_violation', message: `Duty ${duty.id} could not be expanded: ${cause instanceof Error ? cause.message : 'series search failed'}` });
  }
  const newCursor = spawn[spawn.length - 1];
  if (newCursor === undefined) return ok(emptyPlan());

  let next: IsoDateTime | null;
  try {
    next = nextOccurrenceAfter(parts, dtstart, timezone, newCursor);
  } catch (cause) {
    return err({ kind: 'invariant_violation', message: `Duty ${duty.id} next occurrence failed: ${cause instanceof Error ? cause.message : 'series search failed'}` });
  }
  const ops: Op[] = spawn.map(occurrenceAt => ({ kind: 'task.insert', row: instanceFromTemplate(series, occurrenceAt, ctx) }));
  ops.push({ kind: 'duty.update_cursor', id: duty.id, lastSpawnedAt: newCursor, nextOccurrenceAt: next, updatedAt: ctx.now });
  if (next === null) ops.push({ kind: 'duty.update', id: duty.id, ifStatus: 'active', patch: { status: 'ended', updated_at: ctx.now } });
  return ok({ ops, assertions: [{ kind: 'duty.exists', id: duty.id }] });
}
