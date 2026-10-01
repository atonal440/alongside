import { parseSchema } from '../parse/primitives';
import * as v from 'valibot';
import { err, ok, type Result } from '../result';
import {
  calendarDateUtc, LocalDateSchema, LocalTimeSchema, MinuteInstantSchema,
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
  alternatives: { at: MinuteInstant; date: string; time: string }[];
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
function timeError(code: TimeError['code'], message: string, recoveryHint: string, alternatives: TimeError['alternatives'] = []): Result<never, TimeError> {
  const field = code === 'missing_anchor' || code === 'unexpected_anchor' ? 'dateAnchorTime' : code === 'ambiguous_local_time' || code === 'nonexistent_local_time' ? 'time' : 'date';
  return err({ code, path: [field], message, retryable: false, recoveryHint, alternatives });
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
    return value ? [{ at: value, ...localParts(at, zone) }] : [];
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
export function zonedDateInterval(date: LocalDate, zone: Timezone): Result<TimeInterval, TimeError> {
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
    }
    if (start !== undefined && localDate > date) {
      end = at;
      for (let minute = previous; minute <= at; minute += MINUTE_MS) {
        if (minute > start && localParts(minute, zone).date > date) { end = minute; break; }
      }
      break;
    }
    previous = at;
  }
  if (start === undefined) return timeError('skipped_local_date', 'The local date is wholly skipped in this timezone.', 'Choose an existing local date.');
  const startAt = instant(start);
  const endAt = end === undefined ? null : instant(end);
  return startAt && endAt ? ok({ start: startAt, end: endAt }) : timeError('time_out_of_range', 'Date boundaries exceed the supported instant range.', 'Choose an interior date in years 0001–9999.');
}
export function resolveDateBoundary(point: TemporalPoint, role: TaskDateRole): Result<{ at: MinuteInstant; comparison: 'inclusive' | 'exclusive' }, TimeError> {
  if (point.kind === 'instant') return ok({ at: point.at, comparison: 'inclusive' });
  const interval = zonedDateInterval(point.date, point.timezone);
  if (!interval.ok) return interval;
  return ok({ at: role === 'available_from' ? interval.value.start : interval.value.end, comparison: role === 'available_from' ? 'inclusive' : 'exclusive' });
}
export function addCalendarDays(date: LocalDate, days: number): Result<LocalDate, TimeError> {
  const result = calendarDateUtc(date);
  result.setUTCDate(result.getUTCDate() + days);
  const parsed = parseLocalDate(result.toISOString().slice(0, 10));
  return parsed.ok ? ok(parsed.value) : timeError('time_out_of_range', 'Offset date is out of range.', 'Reduce the offset.');
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
    const parsed = parseLocalDate(baseDate);
    if (!parsed.ok) return timeError('time_out_of_range', 'Local date is out of range.', 'Choose an interior date.');
    const date = addCalendarDays(parsed.value, offset.days);
    return date.ok ? contextual(resolveWallTime(date.value, offset.localTime, point.timezone, disambiguation)) : date;
  }
  if (point.kind === 'date' && dateAnchorTime === undefined) return timeError('missing_anchor', 'An elapsed offset from a date requires a local anchor time.', 'Supply dateAnchorTime.');
  const base = point.kind === 'instant' ? ok(point.at) : resolveWallTime(point.date, dateAnchorTime!, point.timezone, disambiguation);
  if (!base.ok) return contextual(base);
  const at = instant(Date.parse(base.value) + offset.minutes * MINUTE_MS);
  return at ? ok(at) : timeError('time_out_of_range', 'Offset instant is out of range.', 'Reduce the offset.');
}

export const parseTemporalPoint = (input: unknown) => parseSchema(TemporalPointSchema, input);
export const parseTimeInterval = (input: unknown) => parseSchema(TimeIntervalSchema, input);
export const parseRelativeOffset = (input: unknown) => parseSchema(RelativeOffsetSchema, input);
