import * as v from 'valibot';
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

export interface RruleParts {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: PositiveInt<999>;
}

const SUPPORTED_KEYS = new Set(['FREQ', 'INTERVAL']);
const SUPPORTED_FREQS = new Set(['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY']);

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

function parseRruleParts(input: string): RruleParts | null {
  const fields = new Map<string, string>();

  for (const rawPart of input.split(';')) {
    const [key, value, ...rest] = rawPart.split('=');
    if (!key || value === undefined || rest.length > 0 || !SUPPORTED_KEYS.has(key) || fields.has(key)) {
      return null;
    }
    fields.set(key, value);
  }

  const freq = fields.get('FREQ');
  if (!freq || !SUPPORTED_FREQS.has(freq)) return null;

  const interval = parsePositiveInterval(fields.get('INTERVAL'));
  if (!interval) return null;

  return { freq: freq as RruleParts['freq'], interval };
}

export function parseRrule(input: unknown): Result<{ rrule: Rrule; parts: RruleParts }, ValidationError[]> {
  if (typeof input !== 'string') {
    return err([validationError('type', 'Expected an RRULE string.')]);
  }

  const parts = parseRruleParts(input);
  if (!parts) {
    return err([validationError('rrule', 'Expected FREQ=DAILY|WEEKLY|MONTHLY|YEARLY with optional INTERVAL=1..999.')]);
  }

  return ok({ rrule: input as Rrule, parts });
}

function dateParts(date: IsoDate): { year: number; month: number; day: number } {
  const [year, month, day] = date.split('-').map(Number);
  return { year, month, day };
}

function isoDateFromUtc(date: Date): IsoDate {
  return unsafeBrand<string, 'IsoDate'>(date.toISOString().slice(0, 10));
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function addMonths(from: IsoDate, monthDelta: number): IsoDate {
  const { year, month, day } = dateParts(from);
  const firstOfTarget = new Date(Date.UTC(year, month - 1 + monthDelta, 1));
  const targetYear = firstOfTarget.getUTCFullYear();
  const targetMonth = firstOfTarget.getUTCMonth() + 1;
  const targetDay = Math.min(day, daysInMonth(targetYear, targetMonth));
  return isoDateFromUtc(new Date(Date.UTC(targetYear, targetMonth - 1, targetDay)));
}

export function nextOccurrence(parts: RruleParts, from: IsoDate): IsoDate {
  parseSchema(IsoDateSchema, from);
  const { year, month, day } = dateParts(from);
  const interval = parts.interval as number;

  switch (parts.freq) {
    case 'DAILY':
      return isoDateFromUtc(new Date(Date.UTC(year, month - 1, day + interval)));
    case 'WEEKLY':
      return isoDateFromUtc(new Date(Date.UTC(year, month - 1, day + interval * 7)));
    case 'MONTHLY':
      return addMonths(from, interval);
    case 'YEARLY':
      return addMonths(from, interval * 12);
  }
}
