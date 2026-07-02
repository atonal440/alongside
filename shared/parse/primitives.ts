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
  const offset = match[8] ?? 'Z';
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

function hasTimezoneIdentifierCase(input: string): boolean {
  return !input.includes('/') || input !== input.toLowerCase();
}

export function isIanaTimezoneString(input: string): boolean {
  if (input === CANONICAL_UTC_TIMEZONE) return true;

  const supported = getTimezoneSet();
  if (supported.has(input)) return true;
  if (!hasTimezoneIdentifierCase(input)) return false;

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

// Normalizes any valid ISO instant to minute-resolution UTC (seconds/millis
// truncated, canonical `Z` offset). Audit timestamps (created_at/updated_at)
// must NOT go through this — LWW merge needs their sub-second precision.
// Use IsoDateTimeSchema/parseIsoDateTime for those instead.
export function truncateToMinuteUtc(input: string): string {
  return `${new Date(input).toISOString().slice(0, 16)}:00Z`;
}

// The one scheduling-datetime parser for fields that are already full
// instants (defer_until, focused_until, and — from Stage 2 on — a duty's
// dtstart/last_spawned_at/next_occurrence_at/occurrence_at): truncates to
// minute resolution rather than rejecting sub-minute precision, so no wire
// client breaks (Decision 4, `docs/plans/duties/02-timestamp-model.md`).
export const IsoDateTimeMinuteSchema = v.pipe(
  v.string(),
  v.check(isIsoDateTimeString, 'Expected a valid ISO date-time with Z or an offset.'),
  v.transform(value => truncateToMinuteUtc(value) as IsoDateTime),
);

export function parseIsoDateTimeMinute(input: unknown): Result<IsoDateTime, ValidationError[]> {
  return parseSchema(IsoDateTimeMinuteSchema, input);
}

// due_date's parser: accepts either a bare calendar date (all-day intent —
// anchored to noon UTC so the displayed date is stable for viewer zones
// UTC-12..+11, see `02-timestamp-model.md` "Migrated") or a full instant
// (truncated to minute resolution like IsoDateTimeMinuteSchema). due_date is
// the one scheduling field still commonly set from a bare date (REST/MCP
// callers, the task edit form's date picker).
export const DueDateTimeSchema = v.pipe(
  v.string(),
  v.transform(value => (isIsoDateString(value) ? `${value}T12:00:00Z` : value)),
  v.check(isIsoDateTimeString, 'Expected a valid ISO calendar date (YYYY-MM-DD) or date-time.'),
  v.transform(value => truncateToMinuteUtc(value) as IsoDateTime),
);

export function parseDueDateTime(input: unknown): Result<IsoDateTime, ValidationError[]> {
  return parseSchema(DueDateTimeSchema, input);
}

// Validates a due_date write-input's shape WITHOUT collapsing it to an
// instant — unlike DueDateTimeSchema, which normalizes a bare date to noon
// UTC. Used at wire boundaries (REST) that need to reject garbage early but
// must not destroy the bare-date-vs-datetime distinction before it reaches
// parseDueDateParts, which is what actually derives due_all_day from it.
export const DueDateStringSchema = v.pipe(
  v.string(),
  v.check(value => isIsoDateString(value) || isIsoDateTimeString(value), 'Expected a valid ISO calendar date (YYYY-MM-DD) or date-time.'),
);

export interface DueDateParts {
  due_date: IsoDateTime;
  due_all_day: boolean;
}

// The write-time source of truth for due_all_day: a bare calendar date
// ("2026-06-30") is all-day intent, anchored to noon UTC; a full instant is
// a genuinely timed due_date. This distinction is only recoverable from the
// as-submitted input shape — once due_date is stored as an instant, a
// timed value that happens to land on noon UTC is indistinguishable from an
// all-day one (see shared/schema.ts's due_all_day comment). Callers that
// already know due_all_day (the PWA, preserving an unrelated edit) should
// pass their own value instead of relying on this.
export function parseDueDateParts(input: unknown): Result<DueDateParts, ValidationError[]> {
  if (typeof input !== 'string') {
    return err([validationError('type', 'Expected a string.')]);
  }
  if (isIsoDateString(input)) {
    return ok({ due_date: truncateToMinuteUtc(`${input}T12:00:00Z`) as IsoDateTime, due_all_day: true });
  }
  if (isIsoDateTimeString(input)) {
    return ok({ due_date: truncateToMinuteUtc(input) as IsoDateTime, due_all_day: false });
  }
  return err([validationError('due_date', 'Expected a valid ISO calendar date (YYYY-MM-DD) or date-time.')]);
}

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
