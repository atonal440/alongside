import * as v from 'valibot';
import { unsafeBrand, type Brand } from '../brand';
import type { Result } from '../result';
import {
  parseIsoDate,
  parseIsoDateTime,
  parseIanaTimezone,
  parseSchema,
  type IanaTimezone,
  type IsoDate,
  type IsoDateTime,
  type ValidationError,
} from './primitives';

export { parseIsoDate, parseIsoDateTime, parseIanaTimezone };
export type { IanaTimezone, IsoDate, IsoDateTime };

/** A validated IANA zone shared by recurrence and planning intent. */
export type Timezone = Brand<string, 'Timezone'>;

let supportedTimezones: ReadonlySet<string> | undefined;

function isSupportedTimezone(value: string): boolean {
  if (value === 'UTC') return true;
  // Intl's enumeration omits IANA fixed-offset identifiers (including UTC−12).
  if (/^Etc\/GMT[+-](?:[0-9]|1[0-4])$/.test(value)) {
    try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(); return true; } catch { return false; }
  }
  if (!supportedTimezones) {
    const intl = Intl as typeof Intl & {
      supportedValuesOf?: (key: 'timeZone') => string[];
    };
    supportedTimezones = new Set(intl.supportedValuesOf?.('timeZone') ?? []);
  }
  return supportedTimezones.has(value);
}

export const TimezoneSchema = v.pipe(
  v.string(),
  v.check(isSupportedTimezone, 'Expected a canonical IANA timezone name or UTC.'),
  v.transform(value => value as Timezone),
);

export function parseTimezone(input: unknown): Result<Timezone, ValidationError[]> {
  return parseSchema(TimezoneSchema, input);
}

export function nowUtc(): IsoDateTime {
  return unsafeBrand<string, 'IsoDateTime'>(new Date().toISOString());
}
