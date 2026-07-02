import { describe, expect, it } from 'vitest';
import {
  parseDueDateTime,
  parseIanaTimezone,
  parseIsoDate,
  parseIsoDateTime,
  parseIsoDateTimeMinute,
  parsePositiveFinite,
  parsePositiveInt,
} from '@shared/parse';

describe('primitive parsers', () => {
  it('accepts real calendar dates and rejects impossible ones', () => {
    expect(parseIsoDate('2024-02-29').ok).toBe(true);
    expect(parseIsoDate('2026-02-29').ok).toBe(false);
    expect(parseIsoDate('2026-02-31').ok).toBe(false);
    expect(parseIsoDate('tomorrow').ok).toBe(false);
  });

  it('requires date-times to include an explicit zone', () => {
    expect(parseIsoDateTime('2026-05-12T09:30:00Z').ok).toBe(true);
    expect(parseIsoDateTime('2026-05-12T09:30:00-07:00').ok).toBe(true);
    expect(parseIsoDateTime('2026-05-12T09:30:00').ok).toBe(false);
    expect(parseIsoDateTime('2026-02-31T09:30:00Z').ok).toBe(false);
  });

  it('parses IANA timezones case-sensitively', () => {
    expect(parseIanaTimezone('UTC').ok).toBe(true);
    expect(parseIanaTimezone('America/Los_Angeles').ok).toBe(true);
    expect(parseIanaTimezone('PDT').ok).toBe(false);
    expect(parseIanaTimezone('etc/utc').ok).toBe(false);
  });

  it('accepts Intl-valid timezone aliases', () => {
    expect(parseIanaTimezone('Etc/UTC').ok).toBe(true);
    expect(parseIanaTimezone('Etc/GMT').ok).toBe(true);
  });

  it('rejects non-positive or unbounded numeric inputs', () => {
    expect(parsePositiveInt(24, 3).ok).toBe(true);
    expect(parsePositiveInt(24, 0).ok).toBe(false);
    expect(parsePositiveInt(24, 25).ok).toBe(false);
    expect(parsePositiveFinite(24, Number.POSITIVE_INFINITY).ok).toBe(false);
  });
});

// Decision 4 (docs/plans/duties/02-timestamp-model.md): scheduling datetimes
// are minute-resolution UTC. These parsers truncate on write rather than
// rejecting sub-minute precision, unlike IsoDateTimeSchema (kept as-is for
// created_at/updated_at, whose LWW merge needs the sub-second detail).
describe('parseIsoDateTimeMinute (minute-resolution scheduling parser)', () => {
  it('truncates seconds and milliseconds to :00', () => {
    const parsed = parseIsoDateTimeMinute('2026-05-12T09:30:45.123Z');
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.value).toBe('2026-05-12T09:30:00Z');
  });

  it('normalizes a non-Z offset to canonical UTC', () => {
    const parsed = parseIsoDateTimeMinute('2026-05-12T09:30:00-07:00');
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.value).toBe('2026-05-12T16:30:00Z');
  });

  it('rejects a bare calendar date (no time component)', () => {
    expect(parseIsoDateTimeMinute('2026-05-12').ok).toBe(false);
  });

  it('rejects garbage input', () => {
    expect(parseIsoDateTimeMinute('tomorrow').ok).toBe(false);
  });
});

describe('parseDueDateTime (due_date parser: bare date or datetime)', () => {
  it('anchors a bare calendar date to noon UTC (all-day convention)', () => {
    const parsed = parseDueDateTime('2026-06-30');
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.value).toBe('2026-06-30T12:00:00Z');
  });

  it('truncates a full instant to minute resolution like parseIsoDateTimeMinute', () => {
    const parsed = parseDueDateTime('2026-05-12T09:30:45.123Z');
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.value).toBe('2026-05-12T09:30:00Z');
  });

  it('rejects an impossible calendar date', () => {
    expect(parseDueDateTime('2026-02-31').ok).toBe(false);
  });

  it('rejects garbage input', () => {
    expect(parseDueDateTime('tomorrow').ok).toBe(false);
  });
});
