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

/** A duty-local IANA zone used to expand its recurrence rule. */
export type Timezone = Brand<string, 'Timezone'>;

let supportedTimezones: ReadonlySet<string> | undefined;

function isSupportedTimezone(value: string): boolean {
  if (value === 'UTC') return true;
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
