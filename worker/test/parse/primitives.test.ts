import { describe, expect, it } from 'vitest';
import {
  parseIanaTimezone,
  parseIsoDate,
  parseIsoDateTime,
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
    expect(parseIanaTimezone('America/Los_Angeles').ok).toBe(true);
    expect(parseIanaTimezone('PDT').ok).toBe(false);
    expect(parseIanaTimezone('etc/utc').ok).toBe(false);
  });

  it('rejects non-positive or unbounded numeric inputs', () => {
    expect(parsePositiveInt(24, 3).ok).toBe(true);
    expect(parsePositiveInt(24, 0).ok).toBe(false);
    expect(parsePositiveInt(24, 25).ok).toBe(false);
    expect(parsePositiveFinite(24, Number.POSITIVE_INFINITY).ok).toBe(false);
  });
});
