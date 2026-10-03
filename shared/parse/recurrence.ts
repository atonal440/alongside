import * as v from 'valibot';
import { RRule, rrulestr } from 'rrule';
import { unsafeBrand } from '../brand';
import type { Brand } from '../brand';
import { err, ok, type Result } from '../result';
import {
  IsoDateSchema,
  parseIsoDateTimeMinute,
  parseSchema,
  truncateToMinuteUtc,
  validationError,
  type IsoDate,
  type IsoDateTime,
  type PositiveInt,
  type ValidationError,
} from './primitives';
import type { Timezone } from './time';
import { floatingCandidates, SeriesSearchBudget } from './seriesIterator';
export { SERIES_SEARCH_WORK_CAP, SeriesSearchLimitError } from './seriesIterator';

export type Rrule = Brand<string, 'Rrule'>;
export type RruleFreq = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
export type SeriesRrule = Brand<string, 'SeriesRrule'>;
export type SeriesRruleFreq = RruleFreq | 'HOURLY' | 'MINUTELY';
export type RruleWeekday = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU';

export interface RruleParts {
  source: Rrule;
  freq: RruleFreq;
  interval: PositiveInt<999>;
}

export interface SeriesRruleParts extends Omit<RruleParts, 'source' | 'freq'> {
  source: SeriesRrule;
  freq: SeriesRruleFreq;
  count?: PositiveInt<10_000>;
  until?: IsoDateTime;
}

export const SERIES_OCCURRENCE_CAP = 10_000;

const SUPPORTED_KEYS = new Set([
  'FREQ',
  'INTERVAL',
  'BYDAY',
  'BYMONTHDAY',
  'BYYEARDAY',
  'BYWEEKNO',
  'BYMONTH',
  'BYSETPOS',
  'WKST',
]);
const SERIES_SUPPORTED_KEYS = new Set([
  ...SUPPORTED_KEYS,
  'COUNT',
  'UNTIL',
  'BYHOUR',
  'BYMINUTE',
]);
const SUPPORTED_FREQS = new Set<RruleFreq>(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']);
const SERIES_SUPPORTED_FREQS = new Set<SeriesRruleFreq>([
  ...SUPPORTED_FREQS,
  'HOURLY',
  'MINUTELY',
]);
const WEEKDAYS = new Set<RruleWeekday>(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']);
const DATE_FILTER_KEYS = ['BYDAY', 'BYMONTHDAY', 'BYYEARDAY', 'BYWEEKNO', 'BYMONTH'] as const;
const PROFILE_PROBE_DATE = new Date(Date.UTC(2000, 0, 1));

export const RruleSchema = v.pipe(
  v.string(),
  v.check(value => parseRrule(value).ok, 'Expected a supported RRULE.'),
  v.transform(value => value as Rrule),
);

export const SeriesRruleSchema = v.pipe(
  v.string(),
  v.check(value => parseSeriesRrule(value).ok, 'Expected a supported series RRULE.'),
  v.transform(value => value as SeriesRrule),
);

function parsePositiveInterval(value: string | undefined): PositiveInt<999> | null {
  if (value === undefined) return unsafeBrand<number, 'PositiveInt:999'>(1);
  if (!/^\d+$/.test(value)) return null;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 999) return null;
  return unsafeBrand<number, 'PositiveInt:999'>(parsed);
}

function parseBoundedInt(value: string, maxAbs: number): number | null {
  if (!/^[+-]?\d+$/.test(value)) return null;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed === 0 || Math.abs(parsed) > maxAbs) return null;
  return parsed;
}

function parseIntegerList(value: string | undefined, maxAbs: number): readonly number[] | null | undefined {
  if (value === undefined) return undefined;

  const parsed: number[] = [];
  for (const item of value.split(',')) {
    const next = parseBoundedInt(item, maxAbs);
    if (next === null) return null;
    parsed.push(next);
  }

  return parsed.length > 0 ? parsed : null;
}

function parseMonthList(value: string | undefined): readonly number[] | null | undefined {
  if (value === undefined) return undefined;

  const parsed: number[] = [];
  for (const item of value.split(',')) {
    if (!/^\d+$/.test(item)) return null;
    const next = Number(item);
    if (!Number.isInteger(next) || next < 1 || next > 12) return null;
    parsed.push(next);
  }

  return parsed.length > 0 ? parsed : null;
}

function parseUnsignedIntegerList(
  value: string | undefined,
  min: number,
  max: number,
): readonly number[] | null | undefined {
  if (value === undefined) return undefined;

  const parsed: number[] = [];
  for (const item of value.split(',')) {
    if (!/^\d+$/.test(item)) return null;
    const next = Number(item);
    if (!Number.isInteger(next) || next < min || next > max) return null;
    parsed.push(next);
  }

  return parsed.length > 0 ? parsed : null;
}

function parseWeekday(value: string | undefined): RruleWeekday | null | undefined {
  if (value === undefined) return undefined;
  return WEEKDAYS.has(value as RruleWeekday) ? value as RruleWeekday : null;
}

function parseByDay(value: string | undefined): readonly { weekday: RruleWeekday; ordinal: number | null }[] | null | undefined {
  if (value === undefined) return undefined;

  const parsed: { weekday: RruleWeekday; ordinal: number | null }[] = [];
  for (const item of value.split(',')) {
    const match = /^([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)$/.exec(item);
    if (!match) return null;

    const ordinal = match[1] === undefined ? null : parseBoundedInt(match[1], 53);
    if (match[1] !== undefined && ordinal === null) return null;

    parsed.push({ weekday: match[2] as RruleWeekday, ordinal });
  }

  return parsed.length > 0 ? parsed : null;
}

function parseFields(input: string, supportedKeys = SUPPORTED_KEYS): Map<string, string> | null {
  const fields = new Map<string, string>();

  for (const rawPart of input.split(';')) {
    const [key, value, ...rest] = rawPart.split('=');
    if (!key || value === undefined || value === '' || rest.length > 0 || !supportedKeys.has(key) || fields.has(key)) {
      return null;
    }
    fields.set(key, value);
  }

  return fields;
}

function hasAnyDateFilter(fields: Map<string, string>): boolean {
  return DATE_FILTER_KEYS.some(key => fields.has(key));
}

function isDateOnlyProfile(fields: Map<string, string>, freq: RruleFreq): boolean {
  const byday = parseByDay(fields.get('BYDAY'));
  if (byday === null) return false;

  if (parseIntegerList(fields.get('BYMONTHDAY'), 31) === null) return false;
  if (parseIntegerList(fields.get('BYYEARDAY'), 366) === null) return false;
  if (parseIntegerList(fields.get('BYWEEKNO'), 53) === null) return false;
  if (parseIntegerList(fields.get('BYSETPOS'), 366) === null) return false;
  if (parseMonthList(fields.get('BYMONTH')) === null) return false;
  if (parseWeekday(fields.get('WKST')) === null) return false;

  if (fields.has('BYSETPOS') && !hasAnyDateFilter(fields)) return false;
  if (freq === 'WEEKLY' && fields.has('BYMONTHDAY')) return false;
  if (freq !== 'YEARLY' && (fields.has('BYYEARDAY') || fields.has('BYWEEKNO'))) return false;

  const hasOrdinalByDay = byday?.some(day => day.ordinal !== null) ?? false;
  if (hasOrdinalByDay) {
    if (freq !== 'MONTHLY' && freq !== 'YEARLY') return false;
    if (freq === 'MONTHLY' && !byday?.every(day => day.ordinal === null || Math.abs(day.ordinal) <= 5)) return false;
    if (freq === 'YEARLY' && fields.has('BYWEEKNO')) return false;
  }

  return true;
}

function isSeriesProfile(fields: Map<string, string>, freq: SeriesRruleFreq): boolean {
  if (freq === 'HOURLY' || freq === 'MINUTELY') {
    return [...fields.keys()].every(key => ['FREQ', 'INTERVAL', 'COUNT', 'UNTIL'].includes(key));
  }
  const byday = parseByDay(fields.get('BYDAY'));
  if (byday === null) return false;

  if (parseIntegerList(fields.get('BYMONTHDAY'), 31) === null) return false;
  if (parseIntegerList(fields.get('BYYEARDAY'), 366) === null) return false;
  if (parseIntegerList(fields.get('BYWEEKNO'), 53) === null) return false;
  if (parseIntegerList(fields.get('BYSETPOS'), 366) === null) return false;
  if (parseMonthList(fields.get('BYMONTH')) === null) return false;
  if (parseWeekday(fields.get('WKST')) === null) return false;
  if (parseUnsignedIntegerList(fields.get('BYHOUR'), 0, 23) === null) return false;
  if (parseUnsignedIntegerList(fields.get('BYMINUTE'), 0, 59) === null) return false;

  const hasAnyFilter = hasAnyDateFilter(fields)
    || fields.has('BYHOUR')
    || fields.has('BYMINUTE');
  if (fields.has('BYSETPOS') && !hasAnyFilter) return false;
  if (freq === 'WEEKLY' && fields.has('BYMONTHDAY')) return false;
  if (freq !== 'YEARLY' && (fields.has('BYYEARDAY') || fields.has('BYWEEKNO'))) return false;

  const hasOrdinalByDay = byday?.some(day => day.ordinal !== null) ?? false;
  if (hasOrdinalByDay) {
    if (freq !== 'MONTHLY' && freq !== 'YEARLY') return false;
    if (freq === 'MONTHLY' && !byday?.every(day => day.ordinal === null || Math.abs(day.ordinal) <= 5)) return false;
    if (freq === 'YEARLY' && fields.has('BYWEEKNO')) return false;
  }

  return true;
}

function parseSeriesCount(value: string | undefined): PositiveInt<10_000> | null | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value)) return null;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > SERIES_OCCURRENCE_CAP) return null;
  return unsafeBrand<number, 'PositiveInt:10000'>(parsed);
}

function parseSeriesUntil(value: string | undefined): IsoDateTime | null | undefined {
  if (value === undefined) return undefined;

  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!match) return null;

  const [, year, month, day, hour, minute, second] = match;
  const parsed = parseIsoDateTimeMinute(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
  return parsed.ok ? parsed.value : null;
}

function isValidSeriesRuleShape(input: string): boolean {
  try {
    return rrulestr(input, { dtstart: PROFILE_PROBE_DATE, cache: false }) instanceof RRule;
  } catch {
    return false;
  }
}

function isNonEmptyInfiniteRule(input: string): boolean {
  try {
    const parsed = rrulestr(input, { dtstart: PROFILE_PROBE_DATE, cache: false });
    if (!(parsed instanceof RRule)) return false;
    return parsed.after(PROFILE_PROBE_DATE, false) !== null;
  } catch {
    return false;
  }
}

function parseRruleParts(input: string): RruleParts | null {
  const fields = parseFields(input);
  if (!fields) return null;

  const freq = fields.get('FREQ');
  if (!freq || !SUPPORTED_FREQS.has(freq as RruleFreq)) return null;

  const interval = parsePositiveInterval(fields.get('INTERVAL'));
  if (!interval) return null;

  if (!isDateOnlyProfile(fields, freq as RruleFreq)) return null;
  if (!isNonEmptyInfiniteRule(input)) return null;

  return {
    source: input as Rrule,
    freq: freq as RruleFreq,
    interval,
  };
}

function parseSeriesRruleParts(input: string): SeriesRruleParts | null {
  if (input.length > 4096) return null;
  const fields = parseFields(input, SERIES_SUPPORTED_KEYS);
  if (!fields) return null;

  const freq = fields.get('FREQ');
  if (!freq || !SERIES_SUPPORTED_FREQS.has(freq as SeriesRruleFreq)) return null;

  const interval = parsePositiveInterval(fields.get('INTERVAL'));
  if (!interval) return null;

  const count = parseSeriesCount(fields.get('COUNT'));
  if (count === null) return null;

  const until = parseSeriesUntil(fields.get('UNTIL'));
  if (until === null) return null;
  if (count !== undefined && until !== undefined) return null;

  if (!isSeriesProfile(fields, freq as SeriesRruleFreq)) return null;
  if (!isValidSeriesRuleShape(input)) return null;

  return {
    source: input as SeriesRrule,
    freq: freq as SeriesRruleFreq,
    interval,
    ...(count === undefined ? {} : { count }),
    ...(until === undefined ? {} : { until }),
  };
}

export function parseRrule(input: unknown): Result<{ rrule: Rrule; parts: RruleParts }, ValidationError[]> {
  if (typeof input !== 'string') {
    return err([validationError('type', 'Expected an RRULE string.')]);
  }

  const parts = parseRruleParts(input);
  if (!parts) {
    return err([validationError('rrule', 'Expected an infinite date-only RRULE.')]);
  }

  return ok({ rrule: input as Rrule, parts });
}

export function parseSeriesRrule(
  input: unknown,
): Result<{ rrule: SeriesRrule; parts: SeriesRruleParts }, ValidationError[]> {
  if (typeof input !== 'string') {
    return err([validationError('type', 'Expected an RRULE string.')]);
  }

  const parts = parseSeriesRruleParts(input);
  if (!parts) {
    return err([validationError('rrule', 'Expected a supported series RRULE.')]);
  }

  return ok({ rrule: input as SeriesRrule, parts });
}

function dateParts(date: IsoDate): { year: number; month: number; day: number } {
  const [year = 0, month = 0, day = 0] = date.split('-').map(Number);
  return { year, month, day };
}

function dateFromIso(date: IsoDate): Date {
  const { year, month, day } = dateParts(date);
  return new Date(Date.UTC(year, month - 1, day));
}

function isoDateFromUtc(date: Date): IsoDate {
  return unsafeBrand<string, 'IsoDate'>(date.toISOString().slice(0, 10));
}

export function nextOccurrence(parts: RruleParts, from: IsoDate): IsoDate {
  parseSchema(IsoDateSchema, from);

  const fromDate = dateFromIso(from);
  const rule = rrulestr(parts.source, { dtstart: fromDate, cache: false });
  if (!(rule instanceof RRule)) {
    throw new Error('Expected RRULE parser to return a single recurrence rule.');
  }

  const next = rule.after(fromDate, false);
  if (!next) {
    throw new Error('Infinite date-only RRULE produced no next occurrence.');
  }

  return isoDateFromUtc(next);
}

export class SeriesExpansionLimitError extends RangeError {
  constructor(limit = SERIES_OCCURRENCE_CAP) {
    super(`Series expansion exceeded ${limit} occurrences.`);
    this.name = 'SeriesExpansionLimitError';
  }
}

interface WallClockParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

interface ExpansionContext {
  parts: SeriesRruleParts;
  anchorInstant: Date;
  anchorWall: Date;
  timezone: Timezone | null;
}

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();
const zoneOffsetCandidates = new Map<string, readonly number[]>();

function canonicalTimezone(timezone: Timezone | null): Timezone | null {
  return timezone === 'UTC' ? null : timezone;
}

function zoneFormatter(timezone: Timezone): Intl.DateTimeFormat {
  const cached = zoneFormatters.get(timezone);
  if (cached) return cached;

  const formatter = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  zoneFormatters.set(timezone, formatter);
  return formatter;
}

function wallClockParts(instant: Date, timezone: Timezone): WallClockParts {
  const values = Object.fromEntries(
    zoneFormatter(timezone)
      .formatToParts(instant)
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value]),
  );

  return {
    year: Number(values['year']),
    month: Number(values['month']),
    day: Number(values['day']),
    hour: Number(values['hour']),
    minute: Number(values['minute']),
    second: Number(values['second']),
  };
}

function utcParts(instant: Date): WallClockParts {
  return {
    year: instant.getUTCFullYear(),
    month: instant.getUTCMonth() + 1,
    day: instant.getUTCDate(),
    hour: instant.getUTCHours(),
    minute: instant.getUTCMinutes(),
    second: instant.getUTCSeconds(),
  };
}

function floatingDate(parts: WallClockParts): Date {
  return new Date(Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  ));
}

function floatingFromInstant(instant: Date, timezone: Timezone | null): Date {
  return timezone ? floatingDate(wallClockParts(instant, timezone)) : new Date(instant.getTime());
}

function sameWallClock(left: WallClockParts, right: WallClockParts): boolean {
  return left.year === right.year
    && left.month === right.month
    && left.day === right.day
    && left.hour === right.hour
    && left.minute === right.minute
    && left.second === right.second;
}

function offsetAt(instant: Date, timezone: Timezone): number {
  return floatingDate(wallClockParts(instant, timezone)).getTime() - instant.getTime();
}

function possibleOffsets(wall: Date, timezone: Timezone): readonly number[] {
  const wallParts = utcParts(wall);
  const cacheKey = `${timezone}:${wallParts.year}-${String(wallParts.month).padStart(2, '0')}`;
  const cached = zoneOffsetCandidates.get(cacheKey);
  if (cached) return cached;

  const monthStart = Date.UTC(wallParts.year, wallParts.month - 1, 1, 12);
  const nextMonth = Date.UTC(wallParts.year, wallParts.month, 1, 12);
  const probes = [
    monthStart - 48 * 60 * 60 * 1_000,
    monthStart,
    Date.UTC(wallParts.year, wallParts.month - 1, 15, 12),
    nextMonth - 1_000,
    nextMonth + 48 * 60 * 60 * 1_000,
    wall.getTime() - 48 * 60 * 60 * 1_000,
    wall.getTime(),
    wall.getTime() + 48 * 60 * 60 * 1_000,
  ];
  const offsets = new Set(probes.map(probe => offsetAt(new Date(probe), timezone)));
  for (let pass = 0; pass < 2; pass += 1) {
    for (const offset of [...offsets]) {
      offsets.add(offsetAt(new Date(wall.getTime() - offset), timezone));
    }
  }

  const result = [...offsets];
  if (zoneOffsetCandidates.size >= 512) zoneOffsetCandidates.clear();
  zoneOffsetCandidates.set(cacheKey, result);
  return result;
}

function wallOrderCushion(instant: Date, timezone: Timezone | null): number {
  if (!timezone) return 0;
  const offsets = possibleOffsets(floatingFromInstant(instant, timezone), timezone);
  return offsets.length < 2 ? 0 : Math.max(...offsets) - Math.min(...offsets);
}

// Invert a floating wall-clock value to a real UTC instant without consulting
// the host timezone. A spring-gap wall time has no match and is skipped; a
// fall-fold wall time has two matches and deterministically chooses the first.
function instantFromFloating(wall: Date, timezone: Timezone): Date | null {
  const wallMs = wall.getTime();
  const wanted = utcParts(wall);
  const matches = possibleOffsets(wall, timezone)
    .map(offset => new Date(wallMs - offset))
    .filter(candidate => sameWallClock(wallClockParts(candidate, timezone), wanted))
    .sort((left, right) => left.getTime() - right.getTime());

  return matches[0] ?? null;
}

function expansionContext(
  parts: SeriesRruleParts,
  dtstart: IsoDateTime,
  timezoneInput: Timezone | null,
): ExpansionContext {
  const anchorInstant = new Date(dtstart);
  if (!Number.isFinite(anchorInstant.getTime())) {
    throw new RangeError('Invalid series DTSTART.');
  }

  const timezone = canonicalTimezone(timezoneInput);
  return {
    parts,
    anchorInstant,
    anchorWall: floatingFromInstant(anchorInstant, timezone),
    timezone,
  };
}

function sourceWithoutFiniteBounds(source: SeriesRrule): string {
  return source
    .split(';')
    .filter(field => !field.startsWith('COUNT=') && !field.startsWith('UNTIL='))
    .join(';');
}

function floatingRule(context: ExpansionContext): RRule {
  const parsed = rrulestr(sourceWithoutFiniteBounds(context.parts.source), {
    dtstart: context.anchorWall,
    cache: false,
  });
  if (!(parsed instanceof RRule)) {
    throw new Error('Expected RRULE parser to return a single recurrence rule.');
  }
  parsed.options.byhour = [...new Set(parsed.options.byhour ?? [])];
  parsed.options.byminute = [...new Set(parsed.options.byminute ?? [])];
  return parsed;
}

function resolveCandidate(context: ExpansionContext, candidate: Date): Date | null {
  // Preserve the exact stored anchor, including the rare case where it is the
  // second occurrence of an ambiguous fall-fold wall time.
  if (candidate.getTime() === context.anchorWall.getTime()) {
    return new Date(context.anchorInstant.getTime());
  }
  return context.timezone
    ? instantFromFloating(candidate, context.timezone)
    : new Date(candidate.getTime());
}

function untilMs(parts: SeriesRruleParts): number | null {
  return parts.until === undefined ? null : Date.parse(parts.until);
}

function canonicalInstant(instant: Date): IsoDateTime {
  return unsafeBrand<string, 'IsoDateTime'>(truncateToMinuteUtc(instant.toISOString()));
}

function visitCountOccurrences(
  context: ExpansionContext,
  visitor: (occurrence: Date) => boolean,
): void {
  const count = context.parts.count;
  if (count === undefined) return;

  const rule = floatingRule(context);
  const seen = new Set<number>();
  let validCount = 0;
  for (const candidate of floatingCandidates(rule, context.anchorWall, 1, null, new SeriesSearchBudget())) {
    const resolved = resolveCandidate(context, candidate);
    if (resolved && resolved >= context.anchorInstant && !seen.has(resolved.getTime())) {
      seen.add(resolved.getTime());
      validCount += 1;
      if (!visitor(resolved)) return;
    }
    if (validCount >= Number(count)) return;
  }
}

function validateLimit(limit: number | undefined): number | undefined {
  if (limit === undefined) return undefined;
  if (!Number.isInteger(limit) || limit < 0 || limit > SERIES_OCCURRENCE_CAP) {
    throw new RangeError(`limit must be an integer from 0 to ${SERIES_OCCURRENCE_CAP}.`);
  }
  return limit;
}

export function occurrencesBetween(
  parts: SeriesRruleParts,
  dtstart: IsoDateTime,
  timezone: Timezone | null,
  after: IsoDateTime | null,
  through: IsoDateTime,
  limit?: number,
): IsoDateTime[] {
  const boundedLimit = validateLimit(limit);
  if (boundedLimit === 0) return [];

  const context = expansionContext(parts, dtstart, timezone);
  const throughMs = Date.parse(through);
  const afterMs = after === null ? null : Date.parse(after);
  if (!Number.isFinite(throughMs) || (afterMs !== null && !Number.isFinite(afterMs))) {
    throw new RangeError('Invalid series expansion boundary.');
  }
  if (throughMs < context.anchorInstant.getTime()) return [];

  const finiteUntil = untilMs(parts);
  const effectiveThrough = finiteUntil === null ? throughMs : Math.min(throughMs, finiteUntil);
  if (effectiveThrough < context.anchorInstant.getTime()) return [];
  if (afterMs !== null && afterMs >= effectiveThrough) return [];

  const outputCap = boundedLimit ?? SERIES_OCCURRENCE_CAP;
  const results: Date[] = [];
  const seen = new Set<number>();
  let outputLimitExceeded = false;
  const visit = (resolved: Date): boolean => {
    const instant = resolved.getTime();
    if (instant < context.anchorInstant.getTime()) return true;
    if (afterMs !== null && instant <= afterMs) return true;
    if (instant > effectiveThrough) return false;
    if (seen.has(instant)) return true;

    if (boundedLimit === undefined && results.length >= outputCap) {
      outputLimitExceeded = true;
      return false;
    }
    seen.add(instant);
    results.push(resolved);
    return boundedLimit === undefined || results.length < outputCap;
  };

  if (parts.count !== undefined) {
    visitCountOccurrences(context, visit);
  } else {
    const lowerInstant = new Date(Math.max(
      context.anchorInstant.getTime(),
      afterMs ?? context.anchorInstant.getTime(),
    ));
    const lowerWall = floatingFromInstant(lowerInstant, context.timezone);
    const searchStart = new Date(Math.max(
      context.anchorWall.getTime(),
      lowerWall.getTime(),
    ));
    const throughInstant = new Date(effectiveThrough);
    const upperWall = new Date(
      floatingFromInstant(throughInstant, context.timezone).getTime()
      + wallOrderCushion(throughInstant, context.timezone),
    );
    const rule = floatingRule(context);
    for (const candidate of floatingCandidates(rule, searchStart, 1, upperWall, new SeriesSearchBudget())) {
      const resolved = resolveCandidate(context, candidate);
      if (resolved && !visit(resolved)) break;
    }
  }

  if (outputLimitExceeded) throw new SeriesExpansionLimitError();
  results.sort((left, right) => left.getTime() - right.getTime());
  return results.map(canonicalInstant);
}

export function nextOccurrenceAfter(
  parts: SeriesRruleParts,
  dtstart: IsoDateTime,
  timezone: Timezone | null,
  after: IsoDateTime | null,
): IsoDateTime | null {
  const context = expansionContext(parts, dtstart, timezone);
  const afterMs = after === null ? null : Date.parse(after);
  if (afterMs !== null && !Number.isFinite(afterMs)) throw new RangeError('Invalid after boundary.');
  const finiteUntil = untilMs(parts);

  if (parts.count !== undefined) {
    let next: Date | null = null;
    visitCountOccurrences(context, occurrence => {
      if (afterMs !== null && occurrence.getTime() <= afterMs) return true;
      next = occurrence;
      return false;
    });
    return next ? canonicalInstant(next) : null;
  }
  if (finiteUntil !== null && afterMs !== null && afterMs >= finiteUntil) return null;

  const lowerInstant = new Date(Math.max(
    context.anchorInstant.getTime(),
    afterMs ?? context.anchorInstant.getTime(),
  ));
  const lowerWall = floatingFromInstant(lowerInstant, context.timezone);
  const searchStart = new Date(Math.max(
    context.anchorWall.getTime(),
    lowerWall.getTime(),
  ));
  const rule = floatingRule(context);
  const untilInstant = finiteUntil === null ? null : new Date(finiteUntil);
  const upperWall = untilInstant === null ? null : new Date(
    floatingFromInstant(untilInstant, context.timezone).getTime()
    + wallOrderCushion(untilInstant, context.timezone),
  );
  for (const candidate of floatingCandidates(rule, searchStart, 1, upperWall, new SeriesSearchBudget())) {
    const resolved = resolveCandidate(context, candidate);
    if (resolved) {
      const instant = resolved.getTime();
      if (finiteUntil !== null && instant > finiteUntil) return null;
      if (instant >= context.anchorInstant.getTime() && (afterMs === null || instant > afterMs)) {
        return canonicalInstant(resolved);
      }
    }
  }

  return null;
}

export function latestOccurrenceAtOrBefore(
  parts: SeriesRruleParts,
  dtstart: IsoDateTime,
  timezone: Timezone | null,
  instant: IsoDateTime,
): IsoDateTime | null {
  const context = expansionContext(parts, dtstart, timezone);
  const requestedMs = Date.parse(instant);
  if (!Number.isFinite(requestedMs)) throw new RangeError('Invalid occurrence boundary.');
  const finiteUntil = untilMs(parts);
  const targetMs = finiteUntil === null ? requestedMs : Math.min(requestedMs, finiteUntil);
  if (targetMs < context.anchorInstant.getTime()) return null;

  if (parts.count !== undefined) {
    let latest: Date | null = null;
    visitCountOccurrences(context, occurrence => {
      if (occurrence.getTime() > targetMs) return false;
      latest = occurrence;
      return true;
    });
    return latest ? canonicalInstant(latest) : null;
  }

  const targetInstant = new Date(targetMs);
  const targetWall = floatingFromInstant(targetInstant, context.timezone);
  const orderCushion = wallOrderCushion(targetInstant, context.timezone);
  const searchUpper = new Date(targetWall.getTime() + orderCushion);
  const rule = floatingRule(context);
  for (const candidate of floatingCandidates(rule, searchUpper, -1, context.anchorWall, new SeriesSearchBudget())) {
    const resolved = resolveCandidate(context, candidate);
    if (resolved) {
      const resolvedMs = resolved.getTime();
      if (resolvedMs >= context.anchorInstant.getTime() && resolvedMs <= targetMs) {
        return canonicalInstant(resolved);
      }
    }
  }

  return null;
}

/** Membership without materializing the history preceding a cursor. */
export function isSeriesOccurrence(
  parts: SeriesRruleParts,
  dtstart: IsoDateTime,
  timezone: Timezone | null,
  instant: IsoDateTime,
): boolean {
  const latest = latestOccurrenceAtOrBefore(parts, dtstart, timezone, instant);
  return latest !== null && Date.parse(latest) === Date.parse(instant);
}

export function isSeriesExhausted(
  parts: SeriesRruleParts,
  dtstart: IsoDateTime,
  timezone: Timezone | null,
  after: IsoDateTime | null,
): boolean {
  if (parts.count === undefined && parts.until === undefined) return false;
  return nextOccurrenceAfter(parts, dtstart, timezone, after) === null;
}
