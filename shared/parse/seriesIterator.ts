import { RRule } from 'rrule';
import Iterinfo from 'rrule-internals/iterinfo/index.js';
import { buildTimeset } from 'rrule-internals/parseoptions.js';
import { combine, fromOrdinal } from 'rrule-internals/dateutil.js';

// Keep the library's calendar masks (week numbering and ordinal weekdays),
// but own traversal and positional selection. Its public queries cannot bound
// empty periods and before() retains every historical match. The dependency is
// pinned; differential tests protect this small adapter on upgrades.
export const SERIES_SEARCH_WORK_CAP = 100_000;

export class SeriesSearchLimitError extends RangeError {
  constructor() {
    super(`Series search exceeded ${SERIES_SEARCH_WORK_CAP} calendar work units.`);
    this.name = 'SeriesSearchLimitError';
  }
}

export class SeriesSearchBudget {
  private remaining = SERIES_SEARCH_WORK_CAP;

  spend(): void {
    if (--this.remaining < 0) throw new SeriesSearchLimitError();
  }
}

const DAY_MS = 86_400_000;

function midnight(year: number, month: number, day: number): Date {
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  date.setUTCHours(0, 0, 0, 0);
  return date;
}

function periodIndex(rule: RRule, near: Date): number {
  const { dtstart, freq, interval, wkst } = rule.options;
  let elapsed: number;
  if (freq === RRule.YEARLY) elapsed = near.getUTCFullYear() - dtstart.getUTCFullYear();
  else if (freq === RRule.MONTHLY) {
    elapsed = (near.getUTCFullYear() - dtstart.getUTCFullYear()) * 12
      + near.getUTCMonth() - dtstart.getUTCMonth();
  } else if (freq === RRule.WEEKLY) {
    const start = midnight(dtstart.getUTCFullYear(), dtstart.getUTCMonth(), dtstart.getUTCDate());
    start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6 - wkst) % 7));
    elapsed = (near.getTime() - start.getTime()) / (7 * DAY_MS);
  } else {
    const unit = freq === RRule.DAILY ? DAY_MS : freq === RRule.HOURLY ? 3_600_000 : 60_000;
    const start = freq === RRule.DAILY
      ? midnight(dtstart.getUTCFullYear(), dtstart.getUTCMonth(), dtstart.getUTCDate())
      : dtstart;
    elapsed = (near.getTime() - start.getTime()) / unit;
  }
  return Math.max(0, Math.floor(elapsed / interval));
}

function periodStart(rule: RRule, index: number): Date {
  const { dtstart, freq, interval, wkst } = rule.options;
  if (index === 0) return dtstart;
  const steps = index * interval;
  if (freq === RRule.YEARLY) return midnight(dtstart.getUTCFullYear() + steps, 0, 1);
  if (freq === RRule.MONTHLY) return midnight(dtstart.getUTCFullYear(), dtstart.getUTCMonth() + steps, 1);
  if (freq === RRule.HOURLY || freq === RRule.MINUTELY) {
    return new Date(dtstart.getTime() + steps * (freq === RRule.HOURLY ? 3_600_000 : 60_000));
  }
  const start = midnight(dtstart.getUTCFullYear(), dtstart.getUTCMonth(), dtstart.getUTCDate());
  if (freq === RRule.WEEKLY) {
    start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6 - wkst) % 7) + steps * 7);
  } else start.setUTCDate(start.getUTCDate() + steps);
  return start;
}

function matchesDay(rule: RRule, info: Iterinfo, day: number): boolean {
  const o = rule.options;
  return !(o.bymonth?.length && !o.bymonth.includes(info.mmask[day]!))
    && !(o.byweekno?.length && !info.wnomask[day])
    && !(o.byweekday?.length && !o.byweekday.includes(info.wdaymask[day]!))
    && !(info.nwdaymask?.length && !info.nwdaymask[day])
    && !((o.bymonthday.length || o.bynmonthday.length)
      && !o.bymonthday.includes(info.mdaymask[day]!)
      && !o.bynmonthday.includes(info.nmdaymask[day]!))
    && !(o.byyearday?.length && (day < info.yearlen
      ? !o.byyearday.includes(day + 1) && !o.byyearday.includes(day - info.yearlen)
      : !o.byyearday.includes(day + 1 - info.yearlen)
        && !o.byyearday.includes(day - info.yearlen - info.nextyearlen)));
}

/** Fixed-anchor, period-indexed traversal. Work is charged even when no day
 * matches; reverse searches never enumerate or retain the preceding history. */
export function* floatingCandidates(
  rule: RRule,
  near: Date,
  direction: 1 | -1,
  boundary: Date | null,
  budget: SeriesSearchBudget,
): Generator<Date> {
  const { freq, dtstart } = rule.options;
  const info = freq <= RRule.DAILY ? new Iterinfo(rule.options) : null;
  const times = info ? buildTimeset(rule.options).sort((a, b) => a.getTime() - b.getTime()) : [];
  for (let index = periodIndex(rule, near); index >= 0; index += direction) {
    const start = periodStart(rule, index);
    if (start.getUTCFullYear() > 9999 || start.getUTCFullYear() < 100) return;
    if (direction === 1 && boundary && start > boundary) return;
    budget.spend();
    if (!info) {
      // The series profile permits only unfiltered sub-day intervals.
      if ((!boundary || (direction === 1 ? start <= boundary : start >= boundary))
        && (direction === 1 ? start >= near : start <= near)) yield start;
      continue;
    }

    info.rebuild(start.getUTCFullYear(), start.getUTCMonth() + 1);
    const [days, first, end] = info.getdayset(freq)(start.getUTCFullYear(), start.getUTCMonth() + 1, start.getUTCDate());
    for (let day = first; day < end; day++) {
      budget.spend();
      const value = days[day];
      if (value !== null && value !== undefined && !matchesDay(rule, info, value)) days[day] = null;
    }
    const eligible = (date: Date) => Number.isFinite(date.getTime()) && date >= dtstart
      && (direction === 1 ? date >= near : date <= near)
      && (!boundary || (direction === 1 ? date <= boundary : date >= boundary));
    if (rule.options.bysetpos?.length) {
      // Select by index into the filtered day/time product. The library's
      // positional helper clamps negative indexes outside that product and
      // can include Invalid Date for positive ones, so it is not safe here.
      const selectedDays = days.slice(first, end)
        .filter((day): day is number => day !== null && day !== undefined);
      const candidateCount = selectedDays.length * times.length;
      const positions = new Map<number, Date>();
      for (const position of rule.options.bysetpos) {
        budget.spend();
        if (Math.abs(position) > candidateCount) continue;
        const index = position < 0 ? candidateCount + position : position - 1;
        const date = fromOrdinal(info.yearordinal + selectedDays[Math.floor(index / times.length)]!);
        const candidate = combine(date, times[index % times.length]!);
        positions.set(candidate.getTime(), candidate);
      }
      const unique = [...positions.values()]
        .sort((a, b) => a.getTime() - b.getTime());
      if (direction === -1) unique.reverse();
      for (const date of unique) {
        budget.spend();
        if (eligible(date)) yield date;
      }
    } else {
      for (let day = direction === 1 ? first : end - 1;
        direction === 1 ? day < end : day >= first; day += direction) {
        const value = days[day];
        if (value === null || value === undefined) continue;
        const date = fromOrdinal(info.yearordinal + value);
        for (let time = direction === 1 ? 0 : times.length - 1;
          direction === 1 ? time < times.length : time >= 0; time += direction) {
          budget.spend();
          const candidate = combine(date, times[time]!);
          if (eligible(candidate)) yield candidate;
        }
      }
    }
  }
}
