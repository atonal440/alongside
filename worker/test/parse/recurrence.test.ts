import { describe, expect, it } from 'vitest';
import { nextOccurrence, parseIsoDate, parseRrule } from '@shared/parse';

describe('recurrence parser', () => {
  it('accepts supported RRULEs', () => {
    expect(parseRrule('FREQ=DAILY').ok).toBe(true);
    expect(parseRrule('FREQ=WEEKLY;INTERVAL=2').ok).toBe(true);
    expect(parseRrule('FREQ=WEEKLY;BYDAY=MO,WE,FR').ok).toBe(true);
    expect(parseRrule('FREQ=MONTHLY;BYDAY=3FR').ok).toBe(true);
    expect(parseRrule('FREQ=MONTHLY;BYDAY=-1SU').ok).toBe(true);
    expect(parseRrule('FREQ=MONTHLY;BYDAY=FR').ok).toBe(true);
    expect(parseRrule('FREQ=MONTHLY;BYDAY=FR;BYSETPOS=3').ok).toBe(true);
    expect(parseRrule('FREQ=MONTHLY;BYMONTHDAY=15,-1').ok).toBe(true);
    expect(parseRrule('FREQ=YEARLY;BYMONTH=11;BYDAY=TH;BYSETPOS=4').ok).toBe(true);
    expect(parseRrule('FREQ=YEARLY;BYYEARDAY=-1').ok).toBe(true);
    expect(parseRrule('FREQ=YEARLY;BYWEEKNO=20;BYDAY=MO;WKST=MO').ok).toBe(true);
  });

  it('rejects malformed or unsupported RRULEs', () => {
    expect(parseRrule('FREQ=WEEKL').ok).toBe(false);
    expect(parseRrule('FREQ=HOURLY').ok).toBe(false);
    expect(parseRrule('FREQ=WEEKLY;INTERVAL=two').ok).toBe(false);
    expect(parseRrule('FREQ=WEEKLY;INTERVAL=0').ok).toBe(false);
    expect(parseRrule('FREQ=WEEKLY;INTERVAL=-1').ok).toBe(false);
    expect(parseRrule('FREQ=WEEKLY;INTERVAL=1000').ok).toBe(false);
    expect(parseRrule('FREQ=WEEKLY;COUNT=2').ok).toBe(false);
    expect(parseRrule('FREQ=WEEKLY;UNTIL=20260601').ok).toBe(false);
    expect(parseRrule('FREQ=DAILY;BYHOUR=9').ok).toBe(false);
    expect(parseRrule('FREQ=DAILY;BYMINUTE=30').ok).toBe(false);
    expect(parseRrule('FREQ=DAILY;BYSECOND=0').ok).toBe(false);
    expect(parseRrule('FREQ=WEEKLY;BYDAY=3FR').ok).toBe(false);
    expect(parseRrule('FREQ=WEEKLY;BYMONTHDAY=1').ok).toBe(false);
    expect(parseRrule('FREQ=MONTHLY;BYYEARDAY=100').ok).toBe(false);
    expect(parseRrule('FREQ=MONTHLY;BYDAY=6FR').ok).toBe(false);
    expect(parseRrule('FREQ=MONTHLY;BYSETPOS=-1').ok).toBe(false);
    expect(parseRrule('FREQ=YEARLY;BYWEEKNO=20;BYDAY=1MO').ok).toBe(false);
    expect(parseRrule('FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=31').ok).toBe(false);
  });

  it('computes the next occurrence from parsed parts', () => {
    const rule = parseRrule('FREQ=WEEKLY;INTERVAL=2');
    const from = parseIsoDate('2026-05-12');

    expect(rule.ok && from.ok ? nextOccurrence(rule.value.parts, from.value) : null).toBe('2026-05-26');
  });

  it('computes monthly positional BYDAY occurrences', () => {
    const rule = parseRrule('FREQ=MONTHLY;BYDAY=3FR');
    const from = parseIsoDate('2026-05-15');

    expect(rule.ok && from.ok ? nextOccurrence(rule.value.parts, from.value) : null).toBe('2026-06-19');
  });

  it('computes monthly positional BYDAY occurrences when a month has no matching position', () => {
    const rule = parseRrule('FREQ=MONTHLY;BYDAY=5FR');
    const from = parseIsoDate('2026-05-29');

    expect(rule.ok && from.ok ? nextOccurrence(rule.value.parts, from.value) : null).toBe('2026-07-31');
  });

  it('computes monthly BYDAY plus BYSETPOS occurrences', () => {
    const rule = parseRrule('FREQ=MONTHLY;BYDAY=FR;BYSETPOS=3');
    const from = parseIsoDate('2026-05-15');

    expect(rule.ok && from.ok ? nextOccurrence(rule.value.parts, from.value) : null).toBe('2026-06-19');
  });

  it('computes bare monthly BYDAY occurrences', () => {
    const rule = parseRrule('FREQ=MONTHLY;BYDAY=FR');
    const from = parseIsoDate('2026-05-15');

    expect(rule.ok && from.ok ? nextOccurrence(rule.value.parts, from.value) : null).toBe('2026-05-22');
  });

  it('computes monthly BYMONTHDAY occurrences', () => {
    const rule = parseRrule('FREQ=MONTHLY;BYMONTHDAY=31');
    const from = parseIsoDate('2026-01-31');

    expect(rule.ok && from.ok ? nextOccurrence(rule.value.parts, from.value) : null).toBe('2026-03-31');
  });

  it('uses RRULE skip semantics for bare monthly rules with invalid target dates', () => {
    const rule = parseRrule('FREQ=MONTHLY');
    const from = parseIsoDate('2026-01-31');

    expect(rule.ok && from.ok ? nextOccurrence(rule.value.parts, from.value) : null).toBe('2026-03-31');
  });

  it('uses RRULE skip semantics for bare yearly rules with invalid target dates', () => {
    const rule = parseRrule('FREQ=YEARLY');
    const from = parseIsoDate('2024-02-29');

    expect(rule.ok && from.ok ? nextOccurrence(rule.value.parts, from.value) : null).toBe('2028-02-29');
  });

  it('computes weekly BYDAY lists before advancing the interval', () => {
    const rule = parseRrule('FREQ=WEEKLY;BYDAY=MO,WE;INTERVAL=2');
    const from = parseIsoDate('2026-05-11');

    expect(rule.ok && from.ok ? nextOccurrence(rule.value.parts, from.value) : null).toBe('2026-05-13');
  });

  it('computes yearly BYMONTH plus BYDAY plus BYSETPOS occurrences', () => {
    const rule = parseRrule('FREQ=YEARLY;BYMONTH=11;BYDAY=TH;BYSETPOS=4');
    const from = parseIsoDate('2026-05-15');

    expect(rule.ok && from.ok ? nextOccurrence(rule.value.parts, from.value) : null).toBe('2026-11-26');
  });
});
