import { parseSchema, type ValidationError } from '../parse/primitives';
import * as v from 'valibot';
import { err, ok, type Result } from '../result';
import {
  LocalDateSchema, LocalTimeSchema, MinuteInstantSchema,
  SignedDaysSchema, SignedMinutesSchema, parseLocalDate, parseMinuteInstant,
  type LocalDate, type LocalTime, type MinuteInstant,
} from '../parse/temporal';
import { TimezoneSchema, type Timezone } from '../parse/time';

export const TemporalPointSchema = v.variant('kind', [
  v.strictObject({ kind: v.literal('date'), date: LocalDateSchema, timezone: TimezoneSchema }),
  v.strictObject({ kind: v.literal('instant'), at: MinuteInstantSchema, timezone: TimezoneSchema }),
]);
export type TemporalPoint = v.InferOutput<typeof TemporalPointSchema>;
export const TaskDateRoleSchema = v.picklist(['available_from', 'target', 'deadline']);
export type TaskDateRole = v.InferOutput<typeof TaskDateRoleSchema>;
export const TimeIntervalSchema = v.pipe(
  v.strictObject({ start: MinuteInstantSchema, end: MinuteInstantSchema }),
  v.check(value => value.end > value.start, 'Interval end must be after start.'),
);
export type TimeInterval = v.InferOutput<typeof TimeIntervalSchema>;
export const RelativeOffsetSchema = v.variant('kind', [
  v.strictObject({ kind: v.literal('elapsed_minutes'), minutes: SignedMinutesSchema }),
  v.strictObject({ kind: v.literal('calendar_days'), days: SignedDaysSchema, localTime: LocalTimeSchema }),
]);
export type RelativeOffset = v.InferOutput<typeof RelativeOffsetSchema>;
export type Disambiguation = 'earlier' | 'later' | 'reject';
export interface TimeError {
  code: 'ambiguous_local_time' | 'nonexistent_local_time' | 'skipped_local_date' | 'missing_anchor' | 'time_out_of_range' | 'unsupported_precision' | 'unexpected_anchor';
  path: string[];
  message: string;
  retryable: false;
  recoveryHint: string;
  alternatives: { at: MinuteInstant; date: LocalDate; time: LocalTime }[];
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timezone: Timezone): Intl.DateTimeFormat {
  let result = formatters.get(timezone);
  if (!result) {
    result = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
      timeZone: timezone, era: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    });
    if (formatters.size >= 128) formatters.clear();
    formatters.set(timezone, result);
  }
  return result;
}
export function localParts(at: number, timezone: Timezone): { date: string; time: string; second: number } {
  const parts = Object.fromEntries(formatter(timezone).formatToParts(at).map(part => [part.type, part.value]));
  const year = parts['era'] === 'BC' ? String(1 - Number(parts['year'])) : (parts['year'] ?? '');
  return { date: `${year.padStart(4, '0')}-${parts['month']}-${parts['day']}`, time: `${parts['hour']}:${parts['minute']}`, second: Number(parts['second']) };
}
function wallMs(date: string, time: string, second = 0): number {
  // Offset probes can cross the supported AD input range. Intl then emits a
  // five-digit year (or astronomical year zero); parse those internal parts
  // without four-digit slicing before rejecting an out-of-range final result.
  const [year = 0, month = 0, day = 0] = date.split('-').map(Number);
  const result = new Date(0);
  result.setUTCFullYear(year, month - 1, day);
  result.setUTCHours(Number(time.slice(0, 2)), Number(time.slice(3, 5)), second, 0);
  return result.getTime();
}
function offsetAt(at: number, zone: Timezone): number {
  const parts = localParts(at, zone);
  return wallMs(parts.date, parts.time, parts.second) - at;
}
function instant(at: number): MinuteInstant | null {
  if (!Number.isFinite(at)) return null;
  const result = parseMinuteInstant(new Date(at).toISOString());
  return result.ok ? result.value : null;
}
function timeError(code: TimeError['code'], message: string, recoveryHint: string, alternatives: TimeError['alternatives'] = [], path?: string[]): Result<never, TimeError> {
  const field = code === 'missing_anchor' || code === 'unexpected_anchor' ? 'dateAnchorTime' : code === 'ambiguous_local_time' || code === 'nonexistent_local_time' ? 'time' : 'date';
  return err({ code, path: path ?? [field], message, retryable: false, recoveryHint, alternatives });
}

/** Invert zoned wall time using explicit offsets and verify every candidate.
 * A fold never silently selects an occurrence; a gap never rolls forward. */
export function resolveWallTime(date: LocalDate, time: LocalTime, zone: Timezone, disambiguation: Disambiguation = 'reject'): Result<MinuteInstant, TimeError> {
  const wall = wallMs(date, time);
  const offsets = new Set<number>();
  for (let h = -48; h <= 48; h += 6) offsets.add(offsetAt(wall + h * HOUR_MS, zone));
  for (const offset of [...offsets]) offsets.add(offsetAt(wall - offset, zone));
  const candidates = [...offsets].map(offset => wall - offset).sort((a, b) => a - b);
  const matches = candidates.filter(at => {
    const parts = localParts(at, zone);
    return parts.date === date && parts.time === time && parts.second === 0;
  });
  const alternatives = candidates.flatMap(at => {
    const value = instant(at);
    if (!value) return [];
    const parts = localParts(Date.parse(value), zone);
    const parsedDate = parseLocalDate(parts.date);
    const parsedTime = parseSchema(LocalTimeSchema, parts.time);
    return parsedDate.ok && parsedTime.ok ? [{ at: value, date: parsedDate.value, time: parsedTime.value }] : [];
  });
  if (!matches.length) return timeError('nonexistent_local_time', 'This local time does not exist in the requested zone.', 'Choose a valid time; alternatives show the offset interpretations.', alternatives);
  if (matches.length > 1 && disambiguation === 'reject') return timeError('ambiguous_local_time', 'This local time occurs twice.', 'Specify earlier or later.', alternatives);
  const selected = disambiguation === 'later' ? matches[matches.length - 1] : matches[0];
  if (selected === undefined) return timeError('time_out_of_range', 'No supported instant.', 'Choose a date in years 0001–9999.');
  if (selected % MINUTE_MS !== 0) return timeError('unsupported_precision', 'Historical zone offset requires sub-minute precision.', 'Choose an explicit offset instant or a modern date.');
  const value = instant(selected);
  return value ? ok(value) : timeError('time_out_of_range', 'Resolved instant is outside the supported range.', 'Choose a date in years 0001–9999.');
}

/** Find the first minute belonging to the date, and the first minute after it.
 * Searching real instants handles midnight gaps/folds and wholly skipped dates.
 * The next date may itself be skipped; no assumed 24-hour interval is used. */
function dateBoundaries(date: LocalDate, zone: Timezone, includeEnd: boolean): Result<{ start: MinuteInstant; end: MinuteInstant | null }, TimeError> {
  const center = wallMs(date, '00:00');
  let start: number | undefined;
  let end: number | undefined;
  let previous = center - 36 * HOUR_MS;
  for (let at = previous; at <= center + 60 * HOUR_MS; at += 15 * MINUTE_MS) {
    const localDate = localParts(at, zone).date;
    if (start === undefined && localDate === date) {
      start = at;
      for (let minute = previous; minute <= at; minute += MINUTE_MS) {
        if (localParts(minute, zone).date === date) { start = minute; break; }
      }
      if (localParts(start - 1_000, zone).date === date) return timeError('unsupported_precision', 'Date start requires sub-minute precision.', 'Choose an explicit instant for this historical boundary.');
    }
    if (start !== undefined && !includeEnd) {
      const atStart = instant(start);
      return atStart ? ok({ start: atStart, end: null }) : timeError('time_out_of_range', 'Date start exceeds the supported instant range.', 'Choose an interior date in years 0001–9999.');
    }
    if (start !== undefined && localDate > date) {
      end = at;
      for (let minute = previous; minute <= at; minute += MINUTE_MS) {
        if (minute > start && localParts(minute, zone).date > date) { end = minute; break; }
      }
      if (localParts(end - 1_000, zone).date > date) return timeError('unsupported_precision', 'Date end requires sub-minute precision.', 'Choose an explicit instant for this historical boundary.');
      break;
    }
    previous = at;
  }
  if (start === undefined) return timeError('skipped_local_date', 'The local date is wholly skipped in this timezone.', 'Choose an existing local date.');
  const startAt = instant(start);
  const endAt = end === undefined ? null : instant(end);
  return startAt && endAt ? ok({ start: startAt, end: endAt }) : timeError('time_out_of_range', 'Date boundaries exceed the supported instant range.', 'Choose an interior date in years 0001–9999.');
}
export function zonedDateStart(date: LocalDate, zone: Timezone): Result<MinuteInstant, TimeError> {
  const result = dateBoundaries(date, zone, false);
  return result.ok ? ok(result.value.start) : result;
}
export function zonedDateInterval(date: LocalDate, zone: Timezone): Result<TimeInterval, TimeError> {
  const result = dateBoundaries(date, zone, true);
  // includeEnd=true succeeds only after both boundaries validate.
  return result.ok ? ok({ start: result.value.start, end: result.value.end! }) : result;
}
export function resolveDateBoundary(point: TemporalPoint, role: TaskDateRole): Result<{ at: MinuteInstant; comparison: 'inclusive' | 'exclusive' }, TimeError> {
  if (point.kind === 'instant') return ok({ at: point.at, comparison: 'inclusive' });
  if (role === 'available_from') {
    const start = zonedDateStart(point.date, point.timezone);
    return start.ok ? ok({ at: start.value, comparison: 'inclusive' }) : start;
  }
  const interval = zonedDateInterval(point.date, point.timezone);
  return interval.ok ? ok({ at: interval.value.end, comparison: 'exclusive' }) : interval;
}
function shiftCalendarDate(date: string, days: number): Result<LocalDate, TimeError> {
  const result = new Date(wallMs(date, '00:00'));
  result.setUTCDate(result.getUTCDate() + days);
  const parsed = parseLocalDate(result.toISOString().slice(0, 10));
  return parsed.ok ? ok(parsed.value) : timeError('time_out_of_range', 'Offset date is out of range.', 'Reduce the offset.');
}
export function addCalendarDays(date: LocalDate, days: number): Result<LocalDate, TimeError> {
  return shiftCalendarDate(date, days);
}
export function resolveOffset(point: TemporalPoint, offset: RelativeOffset, dateAnchorTime: LocalTime | undefined, disambiguation: Disambiguation = 'reject'): Result<MinuteInstant, TimeError> {
  const needsAnchor = offset.kind === 'elapsed_minutes' && point.kind === 'date';
  if (!needsAnchor && dateAnchorTime !== undefined) return timeError('unexpected_anchor', 'dateAnchorTime does not apply to this offset.', 'Remove dateAnchorTime; calendar offsets use offset.localTime and elapsed instant offsets use point.at.');
  function contextual(result: Result<MinuteInstant, TimeError>): Result<MinuteInstant, TimeError> {
    if (result.ok) return result;
    const path = result.error.path[0] === 'time'
      ? offset.kind === 'calendar_days' ? ['offset', 'localTime'] : ['dateAnchorTime']
      : ['point', ...result.error.path];
    return err({ ...result.error, path });
  }
  if (offset.kind === 'calendar_days') {
    const baseDate = point.kind === 'date' ? point.date : localParts(Date.parse(point.at), point.timezone).date;
    // A supported instant may project just outside AD years 0001–9999 in
    // its zone. Apply the calendar shift to those internal parts first; only
    // the final requested date/instant must satisfy the public range.
    const date = shiftCalendarDate(baseDate, offset.days);
    return date.ok ? contextual(resolveWallTime(date.value, offset.localTime, point.timezone, disambiguation)) : err({ ...date.error, path: ['offset', 'days'] });
  }
  if (point.kind === 'date' && dateAnchorTime === undefined) return timeError('missing_anchor', 'An elapsed offset from a date requires a local anchor time.', 'Supply dateAnchorTime.');
  const base = point.kind === 'instant' ? ok(point.at) : resolveWallTime(point.date, dateAnchorTime!, point.timezone, disambiguation);
  if (!base.ok) return contextual(base);
  const at = instant(Date.parse(base.value) + offset.minutes * MINUTE_MS);
  return at ? ok(at) : timeError('time_out_of_range', 'Offset instant is out of range.', 'Reduce the offset.', [], ['offset', 'minutes']);
}

export const parseTemporalPoint = (input: unknown) => parseSchema(TemporalPointSchema, input);
export const parseTimeInterval = (input: unknown) => parseSchema(TimeIntervalSchema, input);
export const parseRelativeOffset = (input: unknown) => parseSchema(RelativeOffsetSchema, input);

/** The single stored spelling of a point: fixed key order, so equal points are equal text. */
export function temporalPointText(point: TemporalPoint): string {
  return JSON.stringify(point.kind === 'date'
    ? { kind: point.kind, date: point.date, timezone: point.timezone }
    : { kind: point.kind, at: point.at, timezone: point.timezone });
}
/**
 * A stored point column: JSON text that parses as a TemporalPoint and is already canonical.
 * Output stays text; parse it into a point with parseTemporalPointText where the value is used.
 */
export const TemporalPointTextSchema = v.pipe(v.string(), v.check(text => {
  try {
    const parsed = parseTemporalPoint(JSON.parse(text));
    return parsed.ok && temporalPointText(parsed.value) === text;
  } catch { return false; }
}, 'Expected canonical TemporalPoint JSON.'));
export function parseTemporalPointText(text: string): Result<TemporalPoint, ValidationError[]> {
  try { return parseTemporalPoint(JSON.parse(text)); } catch {
    return err([{ path: [], code: 'invalid_json', message: 'Expected TemporalPoint JSON.' }]);
  }
}

/**
 * The first reason a task's own availability and deadline cannot both hold, or null. A date
 * boundary that no instant of the zone satisfies is a validation error, and the work window
 * [available_from, deadline] must be non-empty: availability opens strictly before the
 * deadline boundary (end of a date deadline, the instant of a timed one).
 */
export function taskDateRoleProblem(roles: { availableFrom: TemporalPoint | null; deadline: TemporalPoint | null }): { path: string[]; message: string } | null {
  const bounds: Partial<Record<'availableFrom' | 'deadline', MinuteInstant>> = {};
  for (const [field, role] of [['availableFrom', 'available_from'], ['deadline', 'deadline']] as const) {
    const point = roles[field];
    if (point === null) continue;
    const boundary = resolveDateBoundary(point, role);
    if (!boundary.ok) return { path: [field], message: boundary.error.message };
    bounds[field] = boundary.value.at;
  }
  if (bounds.availableFrom !== undefined && bounds.deadline !== undefined && bounds.availableFrom >= bounds.deadline) {
    return { path: ['availableFrom'], message: 'available_from must open before the deadline.' };
  }
  return null;
}
