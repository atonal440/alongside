import type { Duty } from '@shared/types';
import { err, ok, type Result } from '@shared/result';
import {
  isSeriesOccurrence,
  nextOccurrenceAfter,
  parseSeriesRrule,
  type SeriesRruleParts,
} from '@shared/parse/recurrence';
import { parseIsoDateTimeMinute, validationError, type IsoDateTime, type ValidationError } from '@shared/parse/primitives';
import { parseTimezone, type Timezone } from '@shared/parse/time';

/**
 * A duty row whose schedule has been parsed and cross-checked. The calendar is anchored by
 * `dtstart` in `timezone` (null behaves as UTC); `cursor` is the last occurrence materialized.
 */
export interface DutySeries {
  row: Duty;
  parts: SeriesRruleParts;
  dtstart: IsoDateTime;
  timezone: Timezone | null;
  cursor: IsoDateTime | null;
  nextOccurrenceAt: IsoDateTime | null;
}

/** Search budgets and expansion caps are reported as invalid rows, never thrown into a batch. */
function guarded<T>(label: string, run: () => T): Result<T, ValidationError[]> {
  try {
    return ok(run());
  } catch (cause) {
    return err([validationError('series_search', `${label}: ${cause instanceof Error ? cause.message : 'series search failed'}`)]);
  }
}

export function dutyFromRow(row: Duty): Result<DutySeries, ValidationError[]> {
  const errors: ValidationError[] = [];
  const rule = parseSeriesRrule(row.rrule);
  if (!rule.ok) errors.push(...rule.error.map(issue => ({ ...issue, path: ['rrule'] })));
  const dtstart = parseIsoDateTimeMinute(row.dtstart);
  if (!dtstart.ok) errors.push(validationError('dtstart', 'Expected a UTC instant.', ['dtstart']));
  let timezone: Timezone | null = null;
  if (row.timezone !== null) {
    const parsed = parseTimezone(row.timezone);
    if (parsed.ok) timezone = parsed.value; else errors.push(validationError('timezone', 'Expected an IANA timezone.', ['timezone']));
  }
  const cursor = row.last_spawned_at === null ? ok(null) : parseIsoDateTimeMinute(row.last_spawned_at);
  if (!cursor.ok) errors.push(validationError('last_spawned_at', 'Expected a UTC instant.', ['last_spawned_at']));
  const next = row.next_occurrence_at === null ? ok(null) : parseIsoDateTimeMinute(row.next_occurrence_at);
  if (!next.ok) errors.push(validationError('next_occurrence_at', 'Expected a UTC instant.', ['next_occurrence_at']));
  if (!rule.ok || !dtstart.ok || !cursor.ok || !next.ok || errors.length > 0) return err(errors);

  const { parts } = rule.value;
  if (parts.until !== undefined && Date.parse(parts.until) < Date.parse(dtstart.value)) {
    errors.push(validationError('until_before_dtstart', 'The series ends before it starts.', ['rrule']));
  }
  if (row.status === 'ended' && next.value !== null) {
    errors.push(validationError('ended_with_next', 'An ended duty has no next occurrence.', ['next_occurrence_at']));
  }
  if (cursor.value !== null) {
    if (Date.parse(cursor.value) < Date.parse(dtstart.value)) {
      errors.push(validationError('cursor_before_dtstart', 'The cursor precedes the series start.', ['last_spawned_at']));
    } else {
      const onCalendar = guarded('cursor', () => isSeriesOccurrence(parts, dtstart.value, timezone, cursor.value!));
      if (!onCalendar.ok) errors.push(...onCalendar.error);
      else if (!onCalendar.value) errors.push(validationError('cursor_off_calendar', 'The cursor is not an occurrence of the rule.', ['last_spawned_at']));
    }
  }
  if (errors.length === 0 && row.status !== 'ended') {
    const expected = guarded('next occurrence', () => nextOccurrenceAfter(parts, dtstart.value, timezone, cursor.value));
    if (!expected.ok) errors.push(...expected.error);
    else if (expected.value !== next.value) {
      errors.push(validationError('next_mismatch', 'The stored next occurrence does not follow the cursor.', ['next_occurrence_at']));
    }
  }
  if (errors.length > 0) return err(errors);
  return ok({ row, parts, dtstart: dtstart.value, timezone, cursor: cursor.value, nextOccurrenceAt: next.value });
}
