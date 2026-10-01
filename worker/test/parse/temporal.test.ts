import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { parseCommandId, parseEventInstant, parseLocalDate, parseLocalTime, parseMinuteInstant, parsePositiveMinutes, parseRevision, parseSignedDays, parseSortKey, parseTimezone } from '@shared/parse';
import { parseSchema } from '@shared/parse';
import { localParts, resolveDateBoundary, resolveOffset, resolveWallTime, zonedDateInterval, TemporalPointSchema, TimeIntervalSchema } from '@shared/temporal';
import { ResolveTimeInputSchema, parsePlanningSettings } from '@shared/wire/planning';

function value<T>(parsed: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
  return parsed.value;
}
const d = (input: string) => value(parseLocalDate(input));
const t = (input: string) => value(parseLocalTime(input));
const z = (input: string) => value(parseTimezone(input));
const at = (input: string) => value(parseMinuteInstant(input));

describe('temporal boundary parsers', () => {
  it.each(['0001-01-01', '0099-12-31', '2000-02-29', '2024-02-29', '9999-12-31'])('preserves date %s', date => expect(d(date)).toBe(date));
  it.each(['0000-01-01', '1900-02-29', '2026-02-29', '2026-04-31', '2026-1-01', '2026-01-01T00:00:00Z'])('rejects false date %s', date => expect(parseLocalDate(date).ok).toBe(false));
  it('normalizes instants while preserving event precision', () => {
    expect(at('2026-09-30T16:19:59.999999-07:00')).toBe('2026-09-30T23:19:00Z');
    expect(value(parseEventInstant('2026-09-30T16:19:59.123-07:00'))).toBe('2026-09-30T23:19:59.123Z');
    expect(parseEventInstant('2026-09-30T16:19:59.123456-07:00').ok).toBe(false);
    expect(at('0001-01-01T00:00:00Z')).toBe('0001-01-01T00:00:00Z');
  });
  it.each(['2026-09-30T12:30:00', '2026-09-30', '2026-09-30T24:00:00Z', '2026-09-30T12:30:60Z', '9999-12-31T23:00:00-02:00'])('rejects unsupported instant %s', input => expect(parseMinuteInstant(input).ok).toBe(false));
  it('brands bounded numeric values and IDs without coercion', () => {
    expect(parsePositiveMinutes(1).ok).toBe(true);
    expect(parsePositiveMinutes(0).ok).toBe(false);
    expect(parsePositiveMinutes(525601).ok).toBe(false);
    expect(parseRevision(Number.MAX_SAFE_INTEGER + 1).ok).toBe(false);
    expect(parseRevision('1').ok).toBe(false);
    expect(parseSortKey('A0z').ok).toBe(true);
    expect(parseSortKey(' A0z').ok).toBe(false);
    expect(parseCommandId('c_abc123').ok).toBe(true);
    expect(parseCommandId('t_abc123').ok).toBe(false);
  });
  it('rejects unknown keys/null/variant field mixing at new boundaries', () => {
    expect(parseSchema(TemporalPointSchema, { kind: 'date', date: '2026-09-30', timezone: 'UTC', at: '2026-09-30T12:00:00Z' }).ok).toBe(false);
    expect(parseSchema(ResolveTimeInputSchema, { kind: 'wall_time', date: '2026-09-30', time: '09:00', timezone: null }).ok).toBe(false);
    expect(parseSchema(TimeIntervalSchema, { start: '2026-09-30T12:00:00Z', end: '2026-09-30T12:00:00Z' }).ok).toBe(false);
    expect(parsePlanningSettings({ timezone: 'UTC', workingHours: [{ weekday: 1, start: '22:00', end: '02:00' }], bufferMinutes: 0, revision: 0 }).ok).toBe(false);
  });
});

describe('zoned temporal resolution', () => {
  it.each([
    ['2026-03-08', 'America/Los_Angeles', '2026-03-08T08:00:00Z', '2026-03-09T07:00:00Z'],
    ['2026-11-01', 'America/Los_Angeles', '2026-11-01T07:00:00Z', '2026-11-02T08:00:00Z'],
    ['2026-09-30', 'Pacific/Kiritimati', '2026-09-29T10:00:00Z', '2026-09-30T10:00:00Z'],
    ['2026-09-30', 'Etc/GMT+12', '2026-09-30T12:00:00Z', '2026-10-01T12:00:00Z'],
    ['2024-02-29', 'UTC', '2024-02-29T00:00:00Z', '2024-03-01T00:00:00Z'],
    ['2018-11-04', 'America/Sao_Paulo', '2018-11-04T03:00:00Z', '2018-11-05T02:00:00Z'],
    ['2011-12-29', 'Pacific/Apia', '2011-12-29T10:00:00Z', '2011-12-30T10:00:00Z'],
  ])('resolves %s in %s without assuming 24 hours', (date, zone, start, end) => {
    expect(value(zonedDateInterval(d(date), z(zone)))).toEqual({ start, end });
  });
  it('rejects a wholly skipped date and a one-off gap', () => {
    expect(zonedDateInterval(d('2011-12-30'), z('Pacific/Apia'))).toMatchObject({ ok: false, error: { code: 'skipped_local_date' } });
    expect(resolveWallTime(d('2026-03-08'), t('02:30'), z('America/Los_Angeles'), 'later')).toMatchObject({ ok: false, error: { code: 'nonexistent_local_time', alternatives: expect.any(Array) } });
  });
  it('requires explicit selection for repeated one-off times', () => {
    const date = d('2026-11-01'), time = t('01:30'), zone = z('America/Los_Angeles');
    expect(resolveWallTime(date, time, zone)).toMatchObject({ ok: false, error: { code: 'ambiguous_local_time' } });
    expect(value(resolveWallTime(date, time, zone, 'earlier'))).toBe('2026-11-01T08:30:00Z');
    expect(value(resolveWallTime(date, time, zone, 'later'))).toBe('2026-11-01T09:30:00Z');
  });
  it('handles a half-hour DST fold and midnight fold', () => {
    expect(resolveWallTime(d('2026-04-05'), t('01:45'), z('Australia/Lord_Howe'))).toMatchObject({ ok: false, error: { code: 'ambiguous_local_time' } });
    const interval = value(zonedDateInterval(d('2020-11-01'), z('America/Havana')));
    expect(interval.start).toBe('2020-11-01T04:00:00Z');
    expect(interval.end).toBe('2020-11-02T05:00:00Z');
  });
  it('keeps date/zone intent independent of the viewer and host timezone', () => {
    const previous = process.env.TZ;
    try {
      for (const host of ['UTC', 'America/New_York', 'Pacific/Auckland']) {
        process.env.TZ = host;
        const point = { kind: 'date' as const, date: d('2026-09-30'), timezone: z('America/Los_Angeles') };
        expect(value(resolveDateBoundary(point, 'deadline'))).toEqual({ at: '2026-10-01T07:00:00Z', comparison: 'exclusive' });
        expect(value(resolveDateBoundary(point, 'available_from'))).toEqual({ at: '2026-09-30T07:00:00Z', comparison: 'inclusive' });
        expect(value(resolveDateBoundary({ kind: 'instant', at: at('2026-09-30T12:00:00Z'), timezone: point.timezone }, 'deadline')).comparison).toBe('inclusive');
      }
    } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
  });
  it('distinguishes elapsed 24 hours from a calendar day across DST', () => {
    const point = { kind: 'instant' as const, at: at('2026-03-07T17:00:00Z'), timezone: z('America/Los_Angeles') };
    const elapsed = value(parseSchema(ResolveTimeInputSchema, { kind: 'offset', point, offset: { kind: 'elapsed_minutes', minutes: 1440 } }));
    if (elapsed.kind !== 'offset') throw new Error();
    expect(value(resolveOffset(point, elapsed.offset, undefined))).toBe('2026-03-08T17:00:00Z');
    expect(value(resolveOffset(point, { kind: 'calendar_days', days: value(parseSignedDays(1)), localTime: t('09:00') }, undefined))).toBe('2026-03-08T16:00:00Z');
    expect(resolveOffset({ kind: 'date', date: d('2026-03-07'), timezone: point.timezone }, elapsed.offset, undefined)).toMatchObject({ ok: false, error: { code: 'missing_anchor' } });
  });
  it('round-trips structured wall time for representative dates/zones', () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 14_600 }), fc.constantFrom('UTC', 'Asia/Calcutta', 'Pacific/Kiritimati', 'America/Los_Angeles'), (days, zone) => {
      const date = d(new Date(Date.UTC(2000, 0, 1) + days * 86_400_000).toISOString().slice(0, 10));
      const result = value(resolveWallTime(date, t('12:34'), z(zone)));
      expect(localParts(Date.parse(result), z(zone))).toEqual({ date, time: '12:34', second: 0 });
    }), { numRuns: 100 });
  });
});
