import * as v from 'valibot';
import type { BaseIssue, BaseSchema, InferOutput } from 'valibot';
import type { Brand } from '../brand';
import { err, ok, type Result } from '../result';

export interface ValidationError {
  path: string[];
  code: string;
  message: string;
}

export type IsoDate = Brand<string, 'IsoDate'>;
export type IsoDateTime = Brand<string, 'IsoDateTime'>;
export type IanaTimezone = Brand<string, 'IanaTimezone'>;
export type NonEmptyString<Max extends number = number> = Brand<string, `NonEmptyString:${Max}`>;
export type BoundedString<Max extends number = number> = Brand<string, `BoundedString:${Max}`>;
export type PositiveInt<Max extends number = number> = Brand<number, `PositiveInt:${Max}`>;
export type PositiveFiniteNumber<Max extends number = number> = Brand<number, `PositiveFiniteNumber:${Max}`>;

type SyncSchema<T> = BaseSchema<unknown, T, BaseIssue<unknown>>;

const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

let timezoneSet: Set<string> | null = null;
const CANONICAL_UTC_TIMEZONE = 'UTC';

function issuePath(issue: BaseIssue<unknown>): string[] {
  return issue.path?.map(item => String(item.key)) ?? [];
}

export function validationError(code: string, message: string, path: string[] = []): ValidationError {
  return { path, code, message };
}

export function valibotIssueToValidationError(issue: BaseIssue<unknown>): ValidationError {
  return validationError(issue.type, issue.message, issuePath(issue));
}

export function parseSchema<TSchema extends SyncSchema<unknown>>(
  schema: TSchema,
  input: unknown,
): Result<InferOutput<TSchema>, ValidationError[]> {
  const parsed = v.safeParse(schema, input);
  return parsed.success
    ? ok(parsed.output)
    : err(parsed.issues.map(valibotIssueToValidationError));
}

export function isIsoDateString(input: string): boolean {
  const match = ISO_DATE_PATTERN.exec(input);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));

  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

export function isIsoDateTimeString(input: string): boolean {
  const match = ISO_DATE_TIME_PATTERN.exec(input);
  if (!match) return false;

  const datePart = `${match[1]}-${match[2]}-${match[3]}`;
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offset = match[8];
  const offsetHour = offset === 'Z' ? 0 : Number(offset.slice(1, 3));
  const offsetMinute = offset === 'Z' ? 0 : Number(offset.slice(4, 6));

  return (
    isIsoDateString(datePart) &&
    hour >= 0 &&
    hour <= 23 &&
    minute >= 0 &&
    minute <= 59 &&
    second >= 0 &&
    second <= 59 &&
    offsetHour >= 0 &&
    offsetHour <= 23 &&
    offsetMinute >= 0 &&
    offsetMinute <= 59 &&
    Number.isFinite(Date.parse(input))
  );
}

function getTimezoneSet(): Set<string> {
  if (timezoneSet) return timezoneSet;

  const intlWithSupportedValues = Intl as typeof Intl & {
    supportedValuesOf?: (key: 'timeZone') => string[];
  };
  timezoneSet = new Set(intlWithSupportedValues.supportedValuesOf?.('timeZone') ?? []);
  return timezoneSet;
}

export function isIanaTimezoneString(input: string): boolean {
  if (input === CANONICAL_UTC_TIMEZONE) return true;

  const supported = getTimezoneSet();
  if (supported.size > 0) return supported.has(input);

  try {
    new Intl.DateTimeFormat('en-US', { timeZone: input }).format();
    return true;
  } catch {
    return false;
  }
}

export const IsoDateSchema = v.pipe(
  v.string(),
  v.check(isIsoDateString, 'Expected a valid ISO calendar date (YYYY-MM-DD).'),
  v.transform(value => value as IsoDate),
);

export const IsoDateTimeSchema = v.pipe(
  v.string(),
  v.check(isIsoDateTimeString, 'Expected a valid ISO date-time with Z or an offset.'),
  v.transform(value => value as IsoDateTime),
);

export const IanaTimezoneSchema = v.pipe(
  v.string(),
  v.check(isIanaTimezoneString, 'Expected an IANA timezone name.'),
  v.transform(value => value as IanaTimezone),
);

export function nonEmptyStringSchema<const Max extends number>(max: Max): SyncSchema<NonEmptyString<Max>> {
  return v.pipe(
    v.string(),
    v.transform(value => value.trim()),
    v.minLength(1, 'Expected a non-empty string.'),
    v.maxLength(max, `Expected at most ${max} characters.`),
    v.transform(value => value as NonEmptyString<Max>),
  );
}

export function boundedStringSchema<const Max extends number>(max: Max): SyncSchema<BoundedString<Max>> {
  return v.pipe(
    v.string(),
    v.maxLength(max, `Expected at most ${max} characters.`),
    v.transform(value => value as BoundedString<Max>),
  );
}

export function positiveIntSchema<const Max extends number>(max: Max): SyncSchema<PositiveInt<Max>> {
  return v.pipe(
    v.number(),
    v.integer('Expected an integer.'),
    v.minValue(1, 'Expected a positive integer.'),
    v.maxValue(max, `Expected a value no greater than ${max}.`),
    v.transform(value => value as PositiveInt<Max>),
  );
}

export function positiveFiniteNumberSchema<const Max extends number>(
  max: Max,
): SyncSchema<PositiveFiniteNumber<Max>> {
  return v.pipe(
    v.number(),
    v.finite('Expected a finite number.'),
    v.minValue(0, 'Expected a positive number.'),
    v.check(value => value > 0, 'Expected a positive number.'),
    v.maxValue(max, `Expected a value no greater than ${max}.`),
    v.transform(value => value as PositiveFiniteNumber<Max>),
  );
}

export function parseIsoDate(input: unknown): Result<IsoDate, ValidationError[]> {
  return parseSchema(IsoDateSchema, input);
}

export function parseIsoDateTime(input: unknown): Result<IsoDateTime, ValidationError[]> {
  return parseSchema(IsoDateTimeSchema, input);
}

export function parseIanaTimezone(input: unknown): Result<IanaTimezone, ValidationError[]> {
  return parseSchema(IanaTimezoneSchema, input);
}

export function parseNonEmpty<const Max extends number>(
  max: Max,
  input: unknown,
): Result<NonEmptyString<Max>, ValidationError[]> {
  return parseSchema(nonEmptyStringSchema(max), input);
}

export function parseBounded<const Max extends number>(
  max: Max,
  input: unknown,
): Result<BoundedString<Max>, ValidationError[]> {
  return parseSchema(boundedStringSchema(max), input);
}

export function parsePositiveInt<const Max extends number>(
  max: Max,
  input: unknown,
): Result<PositiveInt<Max>, ValidationError[]> {
  return parseSchema(positiveIntSchema(max), input);
}

export function parsePositiveFinite<const Max extends number>(
  max: Max,
  input: unknown,
): Result<PositiveFiniteNumber<Max>, ValidationError[]> {
  return parseSchema(positiveFiniteNumberSchema(max), input);
}
