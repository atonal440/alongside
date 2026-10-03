import { describe, expect, it } from 'vitest';
import { RRule, rrulestr } from 'rrule';
import {
  isSeriesOccurrence, isSeriesExhausted, latestOccurrenceAtOrBefore,
  nextOccurrenceAfter, occurrencesBetween, parseSeriesRrule, parseIsoDateTime, parseIsoDateTimeMinute,
  parseTimezone, SeriesSearchLimitError,
} from '@shared/parse';

function series(source: string) {
  const parsed = parseSeriesRrule(source);
  if (!parsed.ok) throw new Error(`Invalid fixture: ${source}`);
  return parsed.value.parts;
}
function instant(source: string) {
  const parsed = parseIsoDateTimeMinute(source);
  if (!parsed.ok) throw new Error(`Invalid fixture: ${source}`);
  return parsed.value;
}
function zone(source: string) {
  const parsed = parseTimezone(source);
  if (!parsed.ok) throw new Error(`Invalid fixture: ${source}`);
  return parsed.value;
}
const anchor = instant('2000-01-03T09:17:00Z');

describe('bounded series searches', () => {
  it('bounds an empty finite calendar at UNTIL rather than searching through year 9999', () => {
    const parts = series('FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30;UNTIL=20000104T000000Z');
    expect(nextOccurrenceAfter(parts, anchor, null, null)).toBeNull();
    expect(isSeriesExhausted(parts, anchor, null, null)).toBe(true);
    expect(occurrencesBetween(parts, anchor, null, null, instant('2026-01-01T00:00:00Z'))).toEqual([]);
  });

  it('reports a work limit, rather than exhaustion, for an unbounded empty calendar', () => {
    const parts = series('FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30');
    expect(() => nextOccurrenceAfter(parts, anchor, null, null)).toThrow(SeriesSearchLimitError);
    expect(() => latestOccurrenceAtOrBefore(parts, anchor, null, instant('2500-01-01T00:00:00Z'))).toThrow(SeriesSearchLimitError);
    const finite = series('FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30;COUNT=1');
    expect(() => isSeriesExhausted(finite, anchor, null, null)).toThrow(SeriesSearchLimitError);
  });

  it('finds filtered calendar occurrences and validates old cursors without expanding history', () => {
    const parts = series('FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0,30');
    const cursor = instant('2026-01-01T09:30:00Z');
    expect(latestOccurrenceAtOrBefore(parts, anchor, null, cursor)).toBe(cursor);
    expect(isSeriesOccurrence(parts, anchor, null, cursor)).toBe(true);
    const offsetCursor = parseIsoDateTime('2026-01-01T10:30:00.000+01:00');
    if (!offsetCursor.ok) throw new Error('Invalid offset fixture.');
    expect(isSeriesOccurrence(parts, anchor, null, offsetCursor.value)).toBe(true);
    expect(isSeriesOccurrence(parts, anchor, null, instant('2026-01-01T09:31:00Z'))).toBe(false);
    expect(nextOccurrenceAfter(parts, anchor, null, cursor)).toBe('2026-01-02T09:00:00Z');
  });

  it('charges empty periods for limited window queries as well as single-result queries', () => {
    const parts = series('FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30');
    expect(() => occurrencesBetween(parts, anchor, null, null, instant('2500-01-01T00:00:00Z'), 1)).toThrow(SeriesSearchLimitError);
  });

  it('normalizes duplicate time filters before positional selection', () => {
    const parts = series('FREQ=DAILY;BYHOUR=9,9;BYMINUTE=30,0,30;BYSETPOS=-1');
    expect(nextOccurrenceAfter(parts, anchor, null, instant('2026-01-01T00:00:00Z'))).toBe('2026-01-01T09:30:00Z');
  });

  it('orders valid positional candidates after removing out-of-range selections', () => {
    const parts = series('FREQ=MONTHLY;BYMONTHDAY=1,15;BYSETPOS=-1,3,1,2');
    const start = instant('2026-01-01T09:00:00Z');
    const member = instant('2026-01-15T09:00:00Z');
    const through = instant('2026-01-31T09:00:00Z');
    expect(occurrencesBetween(parts, start, null, null, through, 1)).toEqual([start]);
    expect(nextOccurrenceAfter(parts, start, null, null)).toBe(start);
    expect(latestOccurrenceAtOrBefore(parts, start, null, through)).toBe(member);
    expect(isSeriesOccurrence(parts, start, null, member)).toBe(true);
    const counted = series(`${parts.source};COUNT=1`);
    expect(occurrencesBetween(counted, start, null, null, through)).toEqual([start]);
  });

  it('rejects unbounded rule text before allocating filter combinations', () => {
    expect(parseSeriesRrule(`FREQ=DAILY;BYMINUTE=${'0,'.repeat(3000)}0`).ok).toBe(false);
  });
});

describe('calendar-mask adapter compatibility', () => {
  it.each([
    'FREQ=DAILY;INTERVAL=3;BYDAY=MO,WE,FR;BYHOUR=9,15;BYMINUTE=0,30',
    'FREQ=WEEKLY;INTERVAL=3;WKST=SU;BYDAY=MO,FR',
    'FREQ=WEEKLY;INTERVAL=2;BYMONTH=1,3;BYDAY=SU,MO',
    'FREQ=MONTHLY;INTERVAL=3;BYDAY=3FR',
    'FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1',
    'FREQ=MONTHLY;BYMONTHDAY=31,-1;BYHOUR=8,9;BYSETPOS=1,-1',
    'FREQ=YEARLY;INTERVAL=2;BYMONTH=2,11;BYDAY=2MO,-1FR',
    'FREQ=YEARLY;BYDAY=20MO',
    'FREQ=YEARLY;BYYEARDAY=60,-1',
    'FREQ=YEARLY;BYWEEKNO=1,-1;BYDAY=MO,SU;WKST=SU',
    'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29',
  ])('retains fixed-anchor calendar semantics for %s', source => {
    const end = instant('2008-12-31T23:59:00Z');
    const parts = series(source);
    const native = rrulestr(source, { dtstart: new Date(anchor), cache: false });
    if (!(native instanceof RRule)) throw new Error('Expected a single fixture rule.');
    const expected = native.between(new Date(anchor), new Date(end), true)
      .map(date => date.toISOString().replace('.000Z', 'Z'));
    expect(occurrencesBetween(parts, anchor, null, null, end)).toEqual(expected);
    for (const cursor of [instant('2004-03-01T09:17:00Z'), instant('2008-12-01T00:00:00Z')]) {
      const later = expected.filter(value => value > cursor);
      expect(occurrencesBetween(parts, anchor, null, cursor, end, 3)).toEqual(later.slice(0, 3));
      expect(nextOccurrenceAfter(parts, anchor, null, cursor)).toBe(native.after(new Date(cursor), false)?.toISOString().replace('.000Z', 'Z') ?? null);
      expect(latestOccurrenceAtOrBefore(parts, anchor, null, cursor)).toBe(expected.filter(value => value <= cursor).at(-1) ?? null);
    }
  });

  it.each([
    ['America/New_York', '2026-03-07T05:00:00Z', '2026-03-09T05:00:00Z'],
    ['America/New_York', '2026-11-01T06:30:00Z', '2026-11-02T07:00:00Z'],
    ['Australia/Lord_Howe', '2026-04-04T13:00:00Z', '2026-04-06T14:00:00Z'],
    ['Pacific/Apia', '2011-12-29T10:00:00Z', '2012-01-01T10:00:00Z'],
  ])('keeps lookup and enumeration consistent across transitions in %s', (timezone, start, end) => {
    const parts = series('FREQ=MINUTELY;INTERVAL=37');
    const tz = zone(timezone);
    const dtstart = instant(start);
    const through = instant(end);
    const all = occurrencesBetween(parts, dtstart, tz, null, through);
    for (let ms = Date.parse(start); ms <= Date.parse(end); ms += 43 * 60_000) {
      const cursor = instant(new Date(ms).toISOString());
      const later = all.filter(value => value > cursor);
      expect(latestOccurrenceAtOrBefore(parts, dtstart, tz, cursor)).toBe(all.filter(value => value <= cursor).at(-1) ?? null);
      if (later[0]) expect(nextOccurrenceAfter(parts, dtstart, tz, cursor)).toBe(later[0]);
      expect(occurrencesBetween(parts, dtstart, tz, cursor, through, 3)).toEqual(later.slice(0, 3));
    }
  });
});
