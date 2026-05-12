import { describe, expect, it } from 'vitest';
import { nextOccurrence, parseIsoDate, parseRrule } from '@shared/parse';

describe('recurrence parser', () => {
  it('accepts supported RRULEs', () => {
    expect(parseRrule('FREQ=DAILY').ok).toBe(true);
    expect(parseRrule('FREQ=WEEKLY;INTERVAL=2').ok).toBe(true);
  });

  it('rejects malformed or unsupported RRULEs', () => {
    expect(parseRrule('FREQ=WEEKL').ok).toBe(false);
    expect(parseRrule('FREQ=WEEKLY;INTERVAL=0').ok).toBe(false);
    expect(parseRrule('FREQ=WEEKLY;INTERVAL=-1').ok).toBe(false);
    expect(parseRrule('FREQ=WEEKLY;INTERVAL=1000').ok).toBe(false);
    expect(parseRrule('FREQ=WEEKLY;COUNT=2').ok).toBe(false);
  });

  it('computes the next occurrence from parsed parts', () => {
    const rule = parseRrule('FREQ=WEEKLY;INTERVAL=2');
    const from = parseIsoDate('2026-05-12');

    expect(rule.ok && from.ok ? nextOccurrence(rule.value.parts, from.value) : null).toBe('2026-05-26');
  });
});
