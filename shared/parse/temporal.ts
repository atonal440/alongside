import * as v from 'valibot';
import type { Brand } from '../brand';
import { parseSchema } from './primitives';

export type LocalDate = Brand<string, 'LocalDate'>;
export type LocalTime = Brand<string, 'LocalTime'>;
export type MinuteInstant = Brand<string, 'MinuteInstant'>;
export type EventInstant = Brand<string, 'EventInstant'>;
export type PositiveMinutes = Brand<number, 'PositiveMinutes'>;
export type SignedMinutes = Brand<number, 'SignedMinutes'>;
export type SignedDays = Brand<number, 'SignedDays'>;
export type Revision = Brand<number, 'Revision'>;
export type SortKey = Brand<string, 'SortKey'>;

// Avoid Date.UTC's 1900 adjustment for years 00–99 and host-local constructors.
export function calendarDateUtc(value: string): Date {
  const date = new Date(0);
  date.setUTCFullYear(Number(value.slice(0, 4)), Number(value.slice(5, 7)) - 1, Number(value.slice(8, 10)));
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

export function isLocalDate(value: string): boolean {
  return /^(?!0000)\d{4}-\d{2}-\d{2}$/.test(value)
    && calendarDateUtc(value).toISOString().slice(0, 10) === value;
}

function isSupportedInstant(value: string, event = false): boolean {
  // The existing validator intentionally restricts legacy ISO dates to >=100.
  // Validate the new contract independently so all four-digit AD years work.
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !isLocalDate(match[1] ?? '') || (event && (match[5]?.length ?? 0) > 4)) return false;
  const offset = match[6] ?? 'Z';
  return Number(match[2]) < 24 && Number(match[3]) < 60 && Number(match[4]) < 60
    && (offset === 'Z' || (Number(offset.slice(1, 3)) < 24 && Number(offset.slice(4, 6)) < 60))
    && Number.isFinite(Date.parse(value))
    && /^(?!0000)\d{4}-/.test(new Date(value).toISOString());
}

export const LocalDateSchema = v.pipe(v.string(), v.check(isLocalDate, 'Expected a real YYYY-MM-DD date (years 0001–9999).'), v.transform(value => value as LocalDate));
export const LocalTimeSchema = v.pipe(v.string(), v.regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:MM.'), v.transform(value => value as LocalTime));
export const MinuteInstantSchema = v.pipe(v.string(), v.check(isSupportedInstant, 'Expected an ISO instant with an offset or Z.'), v.transform(value => `${new Date(value).toISOString().slice(0, 16)}:00Z` as MinuteInstant));
export const EventInstantSchema = v.pipe(v.string(), v.check(value => isSupportedInstant(value, true), 'Expected an ISO event instant with at most millisecond precision.'), v.transform(value => new Date(value).toISOString() as EventInstant));
export const PositiveMinutesSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(525_600), v.transform(value => value as PositiveMinutes));
export const SignedMinutesSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(-525_600), v.maxValue(525_600), v.transform(value => value as SignedMinutes));
export const SignedDaysSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(-3_660), v.maxValue(3_660), v.transform(value => value as SignedDays));
export const RevisionSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.transform(value => value as Revision));
// ASCII lexical fractional keys. Equal keys are ordered by entity ID. Rebalance
// and between-key generation belong to the hierarchy slice; no numeric casts.
export const SortKeySchema = v.pipe(v.string(), v.regex(/^[0-9A-Za-z]{1,64}$/), v.transform(value => value as SortKey));

export const parseLocalDate = (input: unknown) => parseSchema(LocalDateSchema, input);
export const parseLocalTime = (input: unknown) => parseSchema(LocalTimeSchema, input);
export const parseMinuteInstant = (input: unknown) => parseSchema(MinuteInstantSchema, input);
export const parseEventInstant = (input: unknown) => parseSchema(EventInstantSchema, input);
export const parsePositiveMinutes = (input: unknown) => parseSchema(PositiveMinutesSchema, input);
export const parseSignedMinutes = (input: unknown) => parseSchema(SignedMinutesSchema, input);
export const parseSignedDays = (input: unknown) => parseSchema(SignedDaysSchema, input);
export const parseRevision = (input: unknown) => parseSchema(RevisionSchema, input);
export const parseSortKey = (input: unknown) => parseSchema(SortKeySchema, input);
