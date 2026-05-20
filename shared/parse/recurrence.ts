import * as v from 'valibot';
import { RRule, rrulestr } from 'rrule';
import { unsafeBrand } from '../brand';
import type { Brand } from '../brand';
import { err, ok, type Result } from '../result';
import {
  IsoDateSchema,
  parseSchema,
  validationError,
  type IsoDate,
  type PositiveInt,
  type ValidationError,
} from './primitives';

export type Rrule = Brand<string, 'Rrule'>;
export type RruleFreq = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
export type RruleWeekday = 'MO' | 'TU' | 'WE' | 'TH' | 'FR' | 'SA' | 'SU';

export interface RruleParts {
  source: Rrule;
  freq: RruleFreq;
  interval: PositiveInt<999>;
}

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
const SUPPORTED_FREQS = new Set<RruleFreq>(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']);
const WEEKDAYS = new Set<RruleWeekday>(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']);
const DATE_FILTER_KEYS = ['BYDAY', 'BYMONTHDAY', 'BYYEARDAY', 'BYWEEKNO', 'BYMONTH'] as const;
const PROFILE_PROBE_DATE = new Date(Date.UTC(2000, 0, 1));

export const RruleSchema = v.pipe(
  v.string(),
  v.check(value => parseRrule(value).ok, 'Expected a supported RRULE.'),
  v.transform(value => value as Rrule),
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

function parseFields(input: string): Map<string, string> | null {
  const fields = new Map<string, string>();

  for (const rawPart of input.split(';')) {
    const [key, value, ...rest] = rawPart.split('=');
    if (!key || value === undefined || value === '' || rest.length > 0 || !SUPPORTED_KEYS.has(key) || fields.has(key)) {
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

function dateParts(date: IsoDate): { year: number; month: number; day: number } {
  const [year, month, day] = date.split('-').map(Number);
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
