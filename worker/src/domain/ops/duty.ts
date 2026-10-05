import { err, ok, type Result } from '@shared/result';
import {
  isSeriesExhausted,
  latestOccurrenceAtOrBefore,
  isSeriesOccurrence,
  nextOccurrenceAfter,
  occurrencesBetween,
  parseSeriesRrule,
} from '@shared/parse/recurrence';
import { parseIsoDateTimeMinute, type IsoDateTime } from '@shared/parse/primitives';
import type { Task } from '@shared/types';
import type { TaskId } from '@shared/parse';
import { dutyFromRow, type DutySeries } from '../duty';
import { recurrenceFromRow } from '../task';
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

/**
 * Legacy recurring tasks were date-only, stored at noon UTC. A duty adopted from one has no timezone and a
 * 12:00Z anchor, and its instances stay all-day so they look the way the legacy successors did.
 */
export const allDay = (timezone: string | null, occurrenceAt: string): boolean => timezone === null && occurrenceAt.endsWith('T12:00:00Z');

/** One instance of the duty's template, due at the occurrence and identified by (duty, occurrence). */
export function instanceFromTemplate(series: DutySeries, occurrenceAt: IsoDateTime, ctx: MaterializeCtx): TaskRow {
  const duty = series.row;
  return {
    id: ctx.mintTaskId(), title: duty.title, notes: duty.notes, status: 'pending',
    due_date: occurrenceAt, due_all_day: allDay(duty.timezone, occurrenceAt), recurrence: null,
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

export interface AdoptionOutcome {
  plan: Plan;
  /** True when the task's due date is not an occurrence of its rule: the task stays as a one-off and the duty starts fresh. */
  offCalendar: boolean;
}

/**
 * Plans moving one legacy completion-recurring task onto the calendar engine, keeping a single spawner per
 * record. A due date on the rule's calendar makes the task the duty's current occurrence (cursor there). Any
 * other due date leaves the task as a one-off and starts the duty at the next occurrence on or after it, which is
 * where the legacy successor would have landed. Records the engine cannot represent return an error and keep
 * completing the legacy way: no due date, timed due date, an unparsable or count-limited rule.
 */
export function adoptLegacyTaskPlan(task: Task, now: IsoDateTime): Result<AdoptionOutcome, string> {
  if (task.recurrence === null || task.duty_id !== null || task.status !== 'pending') return err('Not a pending legacy recurring task.');
  const legacy = recurrenceFromRow(task.due_date, task.recurrence, task.due_all_day === null ? null : Boolean(task.due_all_day)); // raw D1 rows carry 0/1
  if (!legacy.ok || legacy.value.kind !== 'recurring') return err('The legacy recurrence is not representable.');
  const rule = parseSeriesRrule(task.recurrence);
  if (!rule.ok) return err('The rule is not a supported series rule.');
  if (rule.value.parts.count !== undefined) return err('A COUNT-limited rule has lost its origin and cannot be adopted.');
  const start = parseIsoDateTimeMinute(task.due_date!);
  if (!start.ok) return err('The due date is not a minute-precision instant.');
  let onCalendar: boolean;
  let next: IsoDateTime | null;
  try {
    onCalendar = isSeriesOccurrence(rule.value.parts, start.value, null, start.value);
    next = nextOccurrenceAfter(rule.value.parts, start.value, null, onCalendar ? start.value : null);
  } catch { return err('The series could not be expanded.'); }
  const row = {
    id: `d_${task.id.slice(2)}`, title: task.title, notes: task.notes, kickoff_note: task.kickoff_note, task_type: task.task_type,
    project_id: task.project_id, rrule: task.recurrence, dtstart: start.value, timezone: null, status: next === null ? 'ended' as const : 'active' as const,
    catch_up: 'next' as const, last_spawned_at: onCalendar ? start.value : null, next_occurrence_at: next, created_at: now, updated_at: now,
  };
  const series = dutyFromRow(row);
  if (!series.ok) return err(series.error.map(issue => issue.message).join('; '));
  return ok({ offCalendar: !onCalendar, plan: { assertions: [{ kind: 'task.exists', id: task.id as TaskId }], ops: [
    { kind: 'duty.adopt_task', duty: row, taskId: task.id as TaskId, dueDate: task.due_date!, recurrence: task.recurrence, occurrenceAt: onCalendar ? start.value : null, updatedAt: now },
  ] } });
}
