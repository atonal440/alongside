import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Result } from '@shared/result';
import {
  SERIES_OCCURRENCE_CAP,
  SeriesExpansionLimitError,
  isSeriesExhausted,
  latestOccurrenceAtOrBefore,
  nextOccurrence,
  nextOccurrenceAfter,
  occurrencesBetween,
  parseIsoDate,
  parseIsoDateTimeMinute,
  parseRrule,
  parseSeriesRrule,
  parseTimezone,
  type IsoDateTime,
  type SeriesRruleParts,
  type Timezone,
} from '@shared/parse';

function expectOk<T, E>(result: Result<T, E>): T {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('Expected ok result.');
  return result.value;
}

function instant(value: string): IsoDateTime {
  return expectOk(parseIsoDateTimeMinute(value));
}

function series(source: string): SeriesRruleParts {
  return expectOk(parseSeriesRrule(source)).parts;
}

function timezone(value: string): Timezone {
  return expectOk(parseTimezone(value));
}

function isoAt(milliseconds: number): IsoDateTime {
  return instant(new Date(milliseconds).toISOString());
}

function expectCanonicalMinuteInstants(values: IsoDateTime[]): void {
  for (const value of values) {
    expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00Z$/);
  }
}

describe('parseSeriesRrule', () => {
  it.each([
    'FREQ=DAILY',
    'FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR',
    'FREQ=MONTHLY;BYDAY=3FR',
    'FREQ=YEARLY;BYMONTH=11;BYDAY=TH;BYSETPOS=4',
    'FREQ=DAILY;COUNT=30',
    'FREQ=DAILY;COUNT=1',
    `FREQ=MINUTELY;COUNT=${SERIES_OCCURRENCE_CAP}`,
    'FREQ=WEEKLY;BYDAY=FR;UNTIL=20261231T235900Z',
    'FREQ=DAILY;BYHOUR=9;BYMINUTE=30',
    'FREQ=HOURLY;INTERVAL=2',
    'FREQ=MINUTELY;INTERVAL=30',
  ])('accepts supported series rule %s', (source) => {
    expect(parseSeriesRrule(source).ok).toBe(true);
  });

  it('normalizes RFC UNTIL to a minute-resolution ISO instant', () => {
    const parsed = expectOk(parseSeriesRrule('FREQ=WEEKLY;UNTIL=20261231T235945Z'));

    expect(parsed.parts.until).toBe('2026-12-31T23:59:00Z');
  });

  it('accepts an anchor-dependent empty rule shape', () => {
    expect(parseSeriesRrule('FREQ=WEEKLY;BYDAY=FR;UNTIL=20260702T090000Z').ok).toBe(true);
  });

  it.each([
    'FREQ=DAILY;COUNT=0',
    'FREQ=DAILY;COUNT=-1',
    'FREQ=DAILY;COUNT=1.5',
    'FREQ=DAILY;COUNT=many',
    `FREQ=DAILY;COUNT=${SERIES_OCCURRENCE_CAP + 1}`,
    'FREQ=DAILY;COUNT=2;COUNT=3',
    'FREQ=DAILY;COUNT=2;UNTIL=20261231T235900Z',
    'FREQ=DAILY;UNTIL=20261231',
    'FREQ=DAILY;UNTIL=2026-12-31T23:59:00Z',
    'FREQ=DAILY;UNTIL=20261231T235900-0800',
    'FREQ=DAILY;BYHOUR=24',
    'FREQ=DAILY;BYMINUTE=60',
    'FREQ=DAILY;BYSECOND=30',
    'FREQ=SECONDLY;INTERVAL=30',
    'FREQ=WEEKL',
    'FREQ=DAILY;FREQ=WEEKLY',
    'FREQ=DAILY\nRDATE:20260102T090000Z',
  ])('rejects invalid or unsupported series rule %s', (source) => {
    expect(parseSeriesRrule(source).ok).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(parseSeriesRrule({ freq: 'DAILY' }).ok).toBe(false);
  });
});

describe('Timezone parser', () => {
  it.each(['UTC', 'America/New_York', 'Europe/Berlin', 'Asia/Kolkata', 'Europe/Kyiv', 'US/Eastern', 'Etc/GMT+5'])('accepts %s', (value) => {
    const parsed = expectOk(parseTimezone(value));
    expect(parsed).toBe(value);
  });

  it.each([
    'PDT',
    'EST',
    'CST',
    'MST',
    'HST',
    'GMT',
    'PST8PDT',
    'utc',
    'America/not_real',
    'america/new_york',
    '',
  ])('rejects ambiguous abbreviations or invalid timezone %s', (value) => {
    expect(parseTimezone(value).ok).toBe(false);
  });
});

describe('legacy recurrence regression', () => {
  it.each([
    'FREQ=DAILY;COUNT=2',
    'FREQ=DAILY;UNTIL=20261231T235900Z',
    'FREQ=DAILY;BYHOUR=9;BYMINUTE=30',
    'FREQ=MINUTELY;INTERVAL=30',
  ])('does not broaden parseRrule when the series parser accepts %s', (source) => {
    expect(parseSeriesRrule(source).ok).toBe(true);
    expect(parseRrule(source).ok).toBe(false);
  });

  it('keeps legacy nextOccurrence date-only and strictly after its input', () => {
    const legacy = expectOk(parseRrule('FREQ=MONTHLY;BYDAY=3FR'));
    const from = expectOk(parseIsoDate('2026-05-15'));

    expect(nextOccurrence(legacy.parts, from)).toBe('2026-06-19');
  });
});

describe('occurrencesBetween boundaries and fixed anchors', () => {
  const daily = series('FREQ=DAILY');
  const dtstart = instant('2026-01-01T09:30:00Z');

  it('uses an inclusive start/through boundary and an exclusive cursor', () => {
    expect(occurrencesBetween(
      daily,
      dtstart,
      null,
      null,
      instant('2026-01-03T09:30:00Z'),
    )).toEqual([
      '2026-01-01T09:30:00Z',
      '2026-01-02T09:30:00Z',
      '2026-01-03T09:30:00Z',
    ]);

    expect(occurrencesBetween(
      daily,
      dtstart,
      null,
      dtstart,
      instant('2026-01-03T09:30:00Z'),
    )).toEqual([
      '2026-01-02T09:30:00Z',
      '2026-01-03T09:30:00Z',
    ]);

    expect(occurrencesBetween(
      daily,
      dtstart,
      null,
      instant('2026-01-01T18:00:00Z'),
      instant('2026-01-02T09:30:00Z'),
    )).toEqual(['2026-01-02T09:30:00Z']);
  });

  it('clamps a pre-anchor cursor and returns nothing before the anchor', () => {
    expect(occurrencesBetween(
      daily,
      dtstart,
      null,
      instant('2025-12-01T00:00:00Z'),
      dtstart,
    )).toEqual(['2026-01-01T09:30:00Z']);

    expect(occurrencesBetween(
      daily,
      dtstart,
      null,
      null,
      instant('2025-12-31T23:59:00Z'),
    )).toEqual([]);
  });

  it('keeps a monthly positional rule anchored when the cursor changes', () => {
    const monthly = series('FREQ=MONTHLY;BYDAY=3FR');
    const anchor = instant('2026-03-20T09:00:00Z');
    const through = instant('2026-05-31T23:59:00Z');
    const all = occurrencesBetween(monthly, anchor, null, null, through);

    expect(all).toEqual([
      '2026-03-20T09:00:00Z',
      '2026-04-17T09:00:00Z',
      '2026-05-15T09:00:00Z',
    ]);
    expect(occurrencesBetween(
      monthly,
      anchor,
      null,
      instant('2026-03-21T00:00:00Z'),
      through,
    )).toEqual(all.slice(1));
    expect(occurrencesBetween(monthly, anchor, null, all[1] ?? null, through)).toEqual(all.slice(2));
  });

  it('enumerates a sub-day rule within one day', () => {
    const values = occurrencesBetween(
      series('FREQ=MINUTELY;INTERVAL=30'),
      instant('2026-01-01T09:15:00Z'),
      null,
      null,
      instant('2026-01-01T11:00:00Z'),
    );

    expect(values).toEqual([
      '2026-01-01T09:15:00Z',
      '2026-01-01T09:45:00Z',
      '2026-01-01T10:15:00Z',
      '2026-01-01T10:45:00Z',
    ]);
    expectCanonicalMinuteInstants(values);
  });

  it.each([
    'FREQ=HOURLY;INTERVAL=2;BYHOUR=1',
    'FREQ=MINUTELY;INTERVAL=2;BYMINUTE=1',
    'FREQ=MINUTELY;INTERVAL=37;BYHOUR=1,13',
    'FREQ=HOURLY;BYDAY=MO',
    'FREQ=MINUTELY;WKST=SU',
  ])('rejects filtered sub-day rule %s before expansion', source => {
    expect(parseSeriesRrule(source).ok).toBe(false);
  });
});

describe('finite COUNT and UNTIL bounds', () => {
  const dtstart = instant('2026-01-01T09:30:00Z');
  const through = instant('2026-01-10T09:30:00Z');

  it('COUNT includes the anchor and stops after the requested number', () => {
    const parts = series('FREQ=DAILY;COUNT=3');

    expect(occurrencesBetween(parts, dtstart, null, null, through)).toEqual([
      '2026-01-01T09:30:00Z',
      '2026-01-02T09:30:00Z',
      '2026-01-03T09:30:00Z',
    ]);
    expect(occurrencesBetween(parts, dtstart, null, dtstart, through)).toEqual([
      '2026-01-02T09:30:00Z',
      '2026-01-03T09:30:00Z',
    ]);
    expect(occurrencesBetween(
      parts,
      dtstart,
      null,
      instant('2026-01-03T09:30:00Z'),
      through,
    )).toEqual([]);
  });

  it('UNTIL is inclusive and excludes later candidates', () => {
    const parts = series('FREQ=DAILY;UNTIL=20260103T093000Z');

    expect(occurrencesBetween(parts, dtstart, null, null, through)).toEqual([
      '2026-01-01T09:30:00Z',
      '2026-01-02T09:30:00Z',
      '2026-01-03T09:30:00Z',
    ]);
    expect(nextOccurrenceAfter(
      parts,
      dtstart,
      null,
      instant('2026-01-03T09:30:00Z'),
    )).toBeNull();
  });

  it('represents anchor-dependent emptiness without rejecting the rule shape', () => {
    const parts = series('FREQ=WEEKLY;BYDAY=FR;UNTIL=20260702T090000Z');
    const thursday = instant('2026-07-02T09:00:00Z');

    expect(occurrencesBetween(
      parts,
      thursday,
      null,
      null,
      instant('2026-07-10T09:00:00Z'),
    )).toEqual([]);
    expect(nextOccurrenceAfter(parts, thursday, null, null)).toBeNull();
    expect(latestOccurrenceAtOrBefore(parts, thursday, null, thursday)).toBeNull();
    expect(isSeriesExhausted(parts, thursday, null, null)).toBe(true);
  });
});

describe('next/latest occurrence and null-cursor semantics', () => {
  const dtstart = instant('2026-01-01T09:30:00Z');

  it('finds the first, strictly-next, and next-after-gap occurrences', () => {
    const daily = series('FREQ=DAILY');

    expect(nextOccurrenceAfter(daily, dtstart, null, null)).toBe('2026-01-01T09:30:00Z');
    expect(nextOccurrenceAfter(daily, dtstart, null, dtstart)).toBe('2026-01-02T09:30:00Z');
    expect(nextOccurrenceAfter(
      daily,
      dtstart,
      null,
      instant('2026-01-01T18:00:00Z'),
    )).toBe('2026-01-02T09:30:00Z');
    expect(nextOccurrenceAfter(
      daily,
      dtstart,
      null,
      instant('2025-12-01T00:00:00Z'),
    )).toBe('2026-01-01T09:30:00Z');
  });

  it('finds the latest occurrence inclusively without crossing the anchor', () => {
    const countThree = series('FREQ=DAILY;COUNT=3');

    expect(latestOccurrenceAtOrBefore(
      countThree,
      dtstart,
      null,
      instant('2025-12-31T23:59:00Z'),
    )).toBeNull();
    expect(latestOccurrenceAtOrBefore(countThree, dtstart, null, dtstart)).toBe(dtstart);
    expect(latestOccurrenceAtOrBefore(
      countThree,
      dtstart,
      null,
      instant('2026-01-02T18:00:00Z'),
    )).toBe('2026-01-02T09:30:00Z');
    expect(latestOccurrenceAtOrBefore(
      countThree,
      dtstart,
      null,
      instant('2027-01-01T00:00:00Z'),
    )).toBe('2026-01-03T09:30:00Z');
  });

  it('does not mark an unspawned COUNT=1 series exhausted', () => {
    const once = series('FREQ=DAILY;COUNT=1');

    expect(isSeriesExhausted(once, dtstart, null, null)).toBe(false);
    expect(isSeriesExhausted(
      once,
      dtstart,
      null,
      instant('2025-12-31T00:00:00Z'),
    )).toBe(false);
    expect(isSeriesExhausted(once, dtstart, null, dtstart)).toBe(true);
  });

  it('distinguishes finite progress from infinite series', () => {
    const three = series('FREQ=DAILY;COUNT=3');
    const infinite = series('FREQ=DAILY');

    expect(isSeriesExhausted(three, dtstart, null, instant('2026-01-02T18:00:00Z'))).toBe(false);
    expect(isSeriesExhausted(three, dtstart, null, instant('2026-01-03T09:30:00Z'))).toBe(true);
    expect(isSeriesExhausted(three, dtstart, null, instant('2027-01-01T00:00:00Z'))).toBe(true);
    expect(isSeriesExhausted(infinite, dtstart, null, null)).toBe(false);
    expect(isSeriesExhausted(infinite, dtstart, null, instant('9999-01-01T00:00:00Z'))).toBe(false);
  });
});

describe('anchor-zone expansion and DST', () => {
  const newYork = timezone('America/New_York');
  const daily = series('FREQ=DAILY');

  it('keeps 09:00 New York stable through the spring-forward transition', () => {
    const values = occurrencesBetween(
      daily,
      instant('2026-03-07T14:00:00Z'),
      newYork,
      null,
      instant('2026-03-09T13:00:00Z'),
    );

    expect(values).toEqual([
      '2026-03-07T14:00:00Z',
      '2026-03-08T13:00:00Z',
      '2026-03-09T13:00:00Z',
    ]);
  });

  it('keeps 09:00 New York stable through the fall-back transition', () => {
    const values = occurrencesBetween(
      daily,
      instant('2026-10-31T13:00:00Z'),
      newYork,
      null,
      instant('2026-11-02T14:00:00Z'),
    );

    expect(values).toEqual([
      '2026-10-31T13:00:00Z',
      '2026-11-01T14:00:00Z',
      '2026-11-02T14:00:00Z',
    ]);
  });

  it('skips a nonexistent spring-gap wall time', () => {
    const values = occurrencesBetween(
      daily,
      instant('2026-03-07T07:30:00Z'),
      newYork,
      null,
      instant('2026-03-09T06:30:00Z'),
    );

    expect(values).toEqual([
      '2026-03-07T07:30:00Z',
      '2026-03-09T06:30:00Z',
    ]);
  });

  it('does not let a spring-gap candidate consume COUNT', () => {
    const countThree = series('FREQ=DAILY;COUNT=3');
    const values = occurrencesBetween(
      countThree,
      instant('2026-03-07T07:30:00Z'),
      newYork,
      null,
      instant('2026-03-10T06:30:00Z'),
    );

    expect(values).toEqual([
      '2026-03-07T07:30:00Z',
      '2026-03-09T06:30:00Z',
      '2026-03-10T06:30:00Z',
    ]);
    expect(isSeriesExhausted(countThree, values[0]!, newYork, values.at(-1)!)).toBe(true);
  });

  it('applies UNTIL as a true UTC instant after zoned expansion', () => {
    const untilBeforeNextInstant = series('FREQ=DAILY;UNTIL=20260308T123000Z');

    expect(occurrencesBetween(
      untilBeforeNextInstant,
      instant('2026-03-07T14:00:00Z'),
      newYork,
      null,
      instant('2026-03-09T13:00:00Z'),
    )).toEqual(['2026-03-07T14:00:00Z']);
  });

  it('chooses the first instant for a repeated fall-fold wall time', () => {
    const values = occurrencesBetween(
      daily,
      instant('2026-10-31T05:30:00Z'),
      newYork,
      null,
      instant('2026-11-02T06:30:00Z'),
    );

    expect(values).toEqual([
      '2026-10-31T05:30:00Z',
      '2026-11-01T05:30:00Z',
      '2026-11-02T06:30:00Z',
    ]);
  });

  it('keeps next/latest cursor semantics unambiguous through a fall fold', () => {
    const foldAnchor = instant('2026-10-31T05:30:00Z');
    const firstFoldInstant = instant('2026-11-01T05:30:00Z');
    const secondFoldInstant = instant('2026-11-01T06:30:00Z');

    expect(nextOccurrenceAfter(daily, foldAnchor, newYork, foldAnchor)).toBe(firstFoldInstant);
    expect(latestOccurrenceAtOrBefore(daily, foldAnchor, newYork, firstFoldInstant)).toBe(firstFoldInstant);
    // The repeated 01:30 at 06:30Z is deliberately not a second occurrence.
    expect(latestOccurrenceAtOrBefore(daily, foldAnchor, newYork, secondFoldInstant)).toBe(firstFoldInstant);
    expect(nextOccurrenceAfter(daily, foldAnchor, newYork, secondFoldInstant)).toBe('2026-11-02T06:30:00Z');
  });

  it('expands correctly in a non-hour-offset zone', () => {
    const eucla = timezone('Australia/Eucla');

    expect(occurrencesBetween(
      daily,
      instant('2026-01-01T03:30:00Z'),
      eucla,
      null,
      instant('2026-01-03T03:30:00Z'),
    )).toEqual([
      '2026-01-01T03:30:00Z',
      '2026-01-02T03:30:00Z',
      '2026-01-03T03:30:00Z',
    ]);
  });

  it('treats null timezone and explicit UTC identically', () => {
    const utc = timezone('UTC');
    const dtstart = instant('2026-03-07T14:00:00Z');
    const through = instant('2026-03-09T14:00:00Z');
    const expected = [
      '2026-03-07T14:00:00Z',
      '2026-03-08T14:00:00Z',
      '2026-03-09T14:00:00Z',
    ];

    expect(occurrencesBetween(daily, dtstart, null, null, through)).toEqual(expected);
    expect(occurrencesBetween(daily, dtstart, utc, null, through)).toEqual(expected);
  });

  it('does not depend on the host process timezone', () => {
    const originalTimezone = process.env.TZ;
    const expand = () => occurrencesBetween(
      daily,
      instant('2026-03-07T14:00:00Z'),
      newYork,
      null,
      instant('2026-03-09T13:00:00Z'),
    );

    try {
      process.env.TZ = 'UTC';
      const fromUtcHost = expand();
      process.env.TZ = 'America/Los_Angeles';
      const fromPacificHost = expand();

      expect(fromPacificHost).toEqual(fromUtcHost);
      expect(fromUtcHost).toEqual([
        '2026-03-07T14:00:00Z',
        '2026-03-08T13:00:00Z',
        '2026-03-09T13:00:00Z',
      ]);
    } finally {
      if (originalTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = originalTimezone;
    }
  });
});

describe('series expansion caps', () => {
  const minutely = series('FREQ=MINUTELY');
  const oldAnchor = instant('2000-01-01T00:00:00Z');

  it('stops at an explicit limit before hitting the runaway cap', () => {
    const values = occurrencesBetween(
      minutely,
      oldAnchor,
      null,
      instant('2025-12-31T23:59:00Z'),
      instant('2026-12-31T23:59:00Z'),
      37,
    );

    expect(values).toHaveLength(37);
    expect(values[0]).toBe('2026-01-01T00:00:00Z');
    expect(values.at(-1)).toBe('2026-01-01T00:36:00Z');
  });

  it('short-circuits a COUNT=10000 series at an explicit limit', () => {
    const atCap = series(`FREQ=MINUTELY;COUNT=${SERIES_OCCURRENCE_CAP}`);
    const values = occurrencesBetween(
      atCap,
      instant('2026-01-01T00:00:00Z'),
      null,
      null,
      instant('2026-01-08T00:00:00Z'),
      17,
    );

    expect(values).toHaveLength(17);
    expect(values[0]).toBe('2026-01-01T00:00:00Z');
    expect(values.at(-1)).toBe('2026-01-01T00:16:00Z');
  });

  it('expands a finite series exactly at the hard cap', () => {
    const atCap = series(`FREQ=MINUTELY;COUNT=${SERIES_OCCURRENCE_CAP}`);
    const values = occurrencesBetween(
      atCap,
      instant('2026-01-01T00:00:00Z'),
      null,
      null,
      instant('2026-01-08T00:00:00Z'),
    );

    expect(values).toHaveLength(SERIES_OCCURRENCE_CAP);
    expect(values[0]).toBe('2026-01-01T00:00:00Z');
    expect(values.at(-1)).toBe('2026-01-07T22:39:00Z');
  });

  it('throws when an infinite window contains 10001 occurrences', () => {
    expect(() => occurrencesBetween(
      minutely,
      instant('2026-01-01T00:00:00Z'),
      null,
      null,
      instant('2026-01-07T22:40:00Z'),
    )).toThrow(SeriesExpansionLimitError);
  });

  it('exposes a stable RangeError for runaway expansions', () => {
    const error = new SeriesExpansionLimitError();
    expect(error).toBeInstanceOf(RangeError);
    expect(error.name).toBe('SeriesExpansionLimitError');
    expect(error.message).toContain(String(SERIES_OCCURRENCE_CAP));
  });

  it('validates explicit limits', () => {
    const through = instant('2026-01-01T01:00:00Z');
    expect(occurrencesBetween(minutely, oldAnchor, null, null, through, 0)).toEqual([]);
    expect(() => occurrencesBetween(minutely, oldAnchor, null, null, through, -1)).toThrow(RangeError);
    expect(() => occurrencesBetween(minutely, oldAnchor, null, null, through, 1.5)).toThrow(RangeError);
    expect(() => occurrencesBetween(
      minutely,
      oldAnchor,
      null,
      null,
      through,
      SERIES_OCCURRENCE_CAP + 1,
    )).toThrow(RangeError);
  });

  it('finds a far-behind latest occurrence without enumerating from the anchor', () => {
    expect(latestOccurrenceAtOrBefore(
      minutely,
      oldAnchor,
      null,
      instant('2026-01-01T12:34:00Z'),
    )).toBe('2026-01-01T12:34:00Z');
  });
});

describe('fast-check recurrence properties', () => {
  const caseArbitrary = fc.record({
    frequency: fc.constantFrom('MINUTELY', 'HOURLY', 'DAILY'),
    interval: fc.integer({ min: 1, max: 5 }),
    start: fc.date({
      min: new Date('2024-01-01T00:00:00Z'),
      max: new Date('2028-12-31T23:59:00Z'),
      noInvalidDate: true,
    }),
    steps: fc.integer({ min: 0, max: 60 }),
    cursorStep: fc.integer({ min: -1, max: 65 }),
    limit: fc.integer({ min: 0, max: 50 }),
  });

  it('returns canonical, strictly ascending occurrences within all bounds', () => {
    fc.assert(fc.property(caseArbitrary, ({ frequency, interval, start, steps, cursorStep, limit }) => {
      const unitMs = frequency === 'MINUTELY'
        ? 60_000
        : frequency === 'HOURLY'
          ? 3_600_000
          : 86_400_000;
      const stepMs = unitMs * interval;
      const startMs = Math.floor(start.getTime() / 60_000) * 60_000;
      const dtstart = isoAt(startMs);
      const through = isoAt(startMs + stepMs * steps);
      const after = cursorStep < 0 ? null : isoAt(startMs + stepMs * cursorStep);
      const parts = series(`FREQ=${frequency};INTERVAL=${interval}`);
      const values = occurrencesBetween(parts, dtstart, null, after, through, limit);
      const milliseconds = values.map(Date.parse);

      expectCanonicalMinuteInstants(values);
      expect(values.length).toBeLessThanOrEqual(limit);
      expect(new Set(milliseconds).size).toBe(milliseconds.length);
      for (let index = 0; index < milliseconds.length; index += 1) {
        const value = milliseconds[index];
        if (value === undefined) throw new Error('Expected occurrence.');
        expect(value).toBeGreaterThanOrEqual(startMs);
        expect(value).toBeLessThanOrEqual(Date.parse(through));
        if (after) expect(value).toBeGreaterThan(Date.parse(after));
        expect((value - startMs) % stepMs).toBe(0);
        if (index > 0) expect(value).toBeGreaterThan(milliseconds[index - 1] ?? value);
      }
    }), { numRuns: 200 });
  });

  it('preserves suffixes, partitions, and next/latest round-trips', () => {
    fc.assert(fc.property(
      caseArbitrary.filter(({ steps }) => steps > 0),
      ({ frequency, interval, start, steps, cursorStep }) => {
        const unitMs = frequency === 'MINUTELY'
          ? 60_000
          : frequency === 'HOURLY'
            ? 3_600_000
            : 86_400_000;
        const stepMs = unitMs * interval;
        const startMs = Math.floor(start.getTime() / 60_000) * 60_000;
        const dtstart = isoAt(startMs);
        const through = isoAt(startMs + stepMs * steps);
        const parts = series(`FREQ=${frequency};INTERVAL=${interval}`);
        const all = occurrencesBetween(parts, dtstart, null, null, through);
        const selectedIndex = Math.min(Math.max(cursorStep, 0), all.length - 1);
        const selected = all[selectedIndex];
        if (!selected) throw new Error('Expected generated occurrence.');

        expect(occurrencesBetween(parts, dtstart, null, selected, through)).toEqual(all.slice(selectedIndex + 1));
        expect(latestOccurrenceAtOrBefore(parts, dtstart, null, selected)).toBe(selected);
        expect(nextOccurrenceAfter(parts, dtstart, null, selected)).toBe(all[selectedIndex + 1]
          ?? isoAt(Date.parse(selected) + stepMs));

        const splitMs = startMs + Math.floor((stepMs * steps) / 2 / 60_000) * 60_000;
        const split = isoAt(splitMs);
        const left = occurrencesBetween(parts, dtstart, null, null, split);
        const right = occurrencesBetween(parts, dtstart, null, split, through);
        expect([...left, ...right]).toEqual(all);
      },
    ), { numRuns: 200 });
  });

  it('honors arbitrary finite COUNT values and null-cursor exhaustion', () => {
    fc.assert(fc.property(
      fc.record({
        frequency: fc.constantFrom('MINUTELY', 'HOURLY', 'DAILY'),
        interval: fc.integer({ min: 1, max: 5 }),
        count: fc.integer({ min: 1, max: 50 }),
        start: fc.date({
          min: new Date('2024-01-01T00:00:00Z'),
          max: new Date('2028-12-31T23:59:00Z'),
          noInvalidDate: true,
        }),
      }),
      ({ frequency, interval, count, start }) => {
        const unitMs = frequency === 'MINUTELY'
          ? 60_000
          : frequency === 'HOURLY'
            ? 3_600_000
            : 86_400_000;
        const stepMs = unitMs * interval;
        const startMs = Math.floor(start.getTime() / 60_000) * 60_000;
        const dtstart = isoAt(startMs);
        const parts = series(`FREQ=${frequency};INTERVAL=${interval};COUNT=${count}`);
        const through = isoAt(startMs + stepMs * (count + 5));
        const values = occurrencesBetween(parts, dtstart, null, null, through);
        const last = values.at(-1);

        expect(values).toHaveLength(count);
        expect(isSeriesExhausted(parts, dtstart, null, null)).toBe(false);
        expect(last).toBeDefined();
        expect(last && isSeriesExhausted(parts, dtstart, null, last)).toBe(true);
        expect(last && nextOccurrenceAfter(parts, dtstart, null, last)).toBeNull();
      },
    ), { numRuns: 200 });
  });
});
