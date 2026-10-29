// Deterministic date, time and recurrence extraction for quick-add text. Pure functions, no
// dependencies, no Intl: written to be ported line for line to Kotlin.
//
// How it works:
//   1. A table of anchored regexes ("recognizers") each claim a span of the text and say what it means
//      (a recurrence rule, a calendar date, a time of day).
//   2. Overlaps are settled longest-span-first, so "on the 1st of every month" beats "the 1st".
//   3. The claimed spans are cut out (plus a dangling "by"/"on"/"due" in front of each), which leaves
//      the text the language model should see: the title and any notes.
//   4. Dates are resolved against a caller-supplied local "now" into wall-clock values: a local date
//      and an optional local time. Zone, DST gaps and folds belong to resolve_time, not to this file.
//
// Output: { date, time, recurrence, approx, rest, spans }
//   date        "YYYY-MM-DD" or null; the first occurrence when there is a recurrence
//   time        "HH:MM" or null; null with a date means all-day
//   recurrence  iCalendar RRULE body (no "RRULE:" prefix) or null
//   approx      true when something vague was guessed ("morning", "next week", "at 5"); show it for confirmation
//   rest        the input with the claimed spans removed
//
// Usage: node scripts/llm-lab/nlparse.mjs "water plants every sunday at 9am"

import { pathToFileURL } from 'node:url';

const WD3 = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const RR_DAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const MON3 = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WD_FULL = 'monday|tuesday|wednesday|thursday|friday|saturday|sunday';
const WD_ANY = `${WD_FULL}|mon|tues?|wed|thu(?:rs?)?|fri|sat|sun`;
const MONTH = 'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec';
const NUM_WORD = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };
const PART_OF_DAY = { morning: '09:00', afternoon: '14:00', evening: '18:00', night: '21:00' };

// Dates are UTC-midnight Date objects used purely as calendar arithmetic.
const mk = (y, m, d) => new Date(Date.UTC(y, m, d));
const addDays = (d, n) => mk(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n);
const ymd = (d) => d.toISOString().slice(0, 10);
const dow = (d) => d.getUTCDay();
const daysInMonth = (y, m) => mk(y, m + 1, 0).getUTCDate();
const pad = (n) => String(n).padStart(2, '0');
const hhmm = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
const wdIndex = (s) => WD3.indexOf(s.toLowerCase().slice(0, 3));
const monthIndex = (s) => MON3.indexOf(s.toLowerCase().slice(0, 3));

// Upcoming weekday. 'after': strictly after today. 'onOrAfter': today counts.
// 'nextWeek': that weekday in the Monday-to-Sunday week after the current one.
function weekdayDate(today, wd, mode) {
  const delta = (wd - dow(today) + 7) % 7;
  if (mode === 'onOrAfter') return addDays(today, delta);
  if (mode === 'after') return addDays(today, delta || 7);
  const toNextMonday = (8 - dow(today)) % 7 || 7;
  return addDays(today, toNextMonday + ((wd + 6) % 7));
}

// A month/day without a year means the next time that date comes around, today included.
function nextMonthDay(today, month, day) {
  // Nine years of look-ahead so that "feb 29" finds the next leap year.
  for (let k = 0; k < 9; k++) {
    const y = today.getUTCFullYear() + k;
    if (day > daysInMonth(y, month)) continue;
    const d = mk(y, month, day);
    if (d >= today) return d;
  }
  return null;
}

// A date the text spells out in full must exist; "2026-02-30" is left alone instead of rolling over to 2 March.
function explicitDate(y, m, d) {
  return m < 0 || m > 11 || d < 1 || d > daysInMonth(y, m) ? null : mk(y, m, d);
}

function nthWeekdayOfMonth(y, m, n, wd) {
  if (n > 0) {
    const day = 1 + ((wd - dow(mk(y, m, 1)) + 7) % 7) + 7 * (n - 1);
    return day > daysInMonth(y, m) ? null : mk(y, m, day);
  }
  const last = mk(y, m + 1, 0);
  return addDays(last, -((dow(last) - wd + 7) % 7));
}

function addMonths(d, n) {
  const t = d.getUTCFullYear() * 12 + d.getUTCMonth() + n;
  const y = Math.floor(t / 12), m = t % 12;
  return mk(y, m, Math.min(d.getUTCDate(), daysInMonth(y, m)));
}

function buildRule(r) {
  return [`FREQ=${r.freq}`, r.interval > 1 && `INTERVAL=${r.interval}`,
    r.byday && `BYDAY=${r.byday.join(',')}`, r.bymonthday && `BYMONTHDAY=${r.bymonthday.join(',')}`]
    .filter(Boolean).join(';');
}

function matchesRule(r, d) {
  if (r.freq === 'WEEKLY' && r.byday) return r.byday.includes(RR_DAY[dow(d)]);
  if (r.freq === 'MONTHLY' && r.bymonthday)
    return r.bymonthday.some((n) => (n === -1 ? d.getUTCDate() === daysInMonth(d.getUTCFullYear(), d.getUTCMonth()) : d.getUTCDate() === n));
  if (r.freq === 'MONTHLY' && r.nth) {
    const hit = nthWeekdayOfMonth(d.getUTCFullYear(), d.getUTCMonth(), r.nth.n, r.nth.wd);
    return !!hit && +hit === +d;
  }
  return true;
}

const ordinal = '(\\d{1,2})(?:st|nd|rd|th)?';
const wdList = `(?:${WD_ANY})s?`;
const recognizers = [];
// Every recognizer starts on a word boundary, so "each morning" is not found inside "teach morning".
const rule = (kind, source, fn) => recognizers.push({ kind, re: new RegExp(/^(\\b|\(\?<=)/.test(source) ? source : `\\b${source}`, 'gi'), fn });

// ---- recurrence ----
rule('rec', `(?:on\\s+)?(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)\\s+of\\s+(?:every|each)\\s+month\\b`,
  (m) => ({ rec: { freq: 'MONTHLY', interval: 1, bymonthday: [+m[1]] } }));
rule('rec', `(?:on\\s+)?(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+and\\s+(?:the\\s+)?(\\d{1,2})(?:st|nd|rd|th)\\s+of\\s+(?:every|each)\\s+month\\b`,
  (m) => ({ rec: { freq: 'MONTHLY', interval: 1, bymonthday: [+m[1], +m[2]] } }));
rule('rec', `(?:(?:every|each)\\s+month|monthly)\\s+on\\s+the\\s+${ordinal}\\b`,
  (m) => ({ rec: { freq: 'MONTHLY', interval: 1, bymonthday: [+m[1]] } }));
rule('rec', `(?:every|each)\\s+(\\d{1,2})(?:st|nd|rd|th)\\b(?!\\s+(?:of|day|week|month|(?:${WD_ANY})\\b))`,
  (m) => ({ rec: { freq: 'MONTHLY', interval: 1, bymonthday: [+m[1]] } }));
rule('rec', `(?:on\\s+)?the\\s+last\\s+day\\s+of\\s+(?:every|each)\\s+month\\b`,
  () => ({ rec: { freq: 'MONTHLY', interval: 1, bymonthday: [-1] } }));
rule('rec', `(?:every|each)\\s+(first|second|third|fourth|last|\\d{1,2}(?:st|nd|rd|th))\\s+(${WD_ANY})(?:\\s+of\\s+the\\s+month)?\\b`, (m) => {
  const word = m[1].toLowerCase();
  const n = { first: 1, second: 2, third: 3, fourth: 4, last: -1 }[word] ?? parseInt(word, 10);
  if (!(n === -1 || (n >= 1 && n <= 5))) return null; // a month has at most five of a weekday
  return { rec: { freq: 'MONTHLY', interval: 1, nth: { n, wd: wdIndex(m[2]) }, byday: [`${n}${RR_DAY[wdIndex(m[2])]}`] } };
});
rule('rec', `(?:every|each)\\s+other\\s+(${WD_ANY})\\b`,
  (m) => ({ rec: { freq: 'WEEKLY', interval: 2, byday: [RR_DAY[wdIndex(m[1])]] } }));
rule('rec', `(?:every|each)\\s+(\\d+|other|two|three|four)\\s+(day|week|month|year)s?(?:\\s+on\\s+(${wdList}(?:(?:\\s*,\\s*|\\s+and\\s+)${wdList})*))?\\b`, (m) => {
  const freq = { day: 'DAILY', week: 'WEEKLY', month: 'MONTHLY', year: 'YEARLY' }[m[2].toLowerCase()];
  const byday = freq === 'WEEKLY' && m[3] ? [...new Set([...m[3].matchAll(new RegExp(`\\b(${WD_ANY})`, 'gi'))].map((x) => RR_DAY[wdIndex(x[1])]))] : undefined;
  return { rec: { freq, byday, interval: m[1].toLowerCase() === 'other' ? 2 : +m[1] || NUM_WORD[m[1].toLowerCase()] } };
});
rule('rec', `\\b(weekday|weekend)s\\b`,
  (m) => ({ rec: { freq: 'WEEKLY', interval: 1, byday: m[1].toLowerCase() === 'weekday' ? ['MO', 'TU', 'WE', 'TH', 'FR'] : ['SA', 'SU'] } }));
// "gym mon wed fri": two or more abbreviations in a row, no "every" needed.
rule('rec', `\\b(?:mon|tues?|wed|thu(?:rs?)?|fri|sat|sun)(?:(?:\\s*,\\s*|\\s+)(?:mon|tues?|wed|thu(?:rs?)?|fri|sat|sun))+\\b`,
  (m) => ({ rec: { freq: 'WEEKLY', interval: 1, byday: [...new Set([...m[0].matchAll(/[a-z]+/gi)].map((x) => RR_DAY[wdIndex(x[0])]))] } }));
rule('rec', `(?:every|each)\\s+(weekday|weekend)s?\\b`,
  (m) => ({ rec: { freq: 'WEEKLY', interval: 1, byday: m[1].toLowerCase() === 'weekday' ? ['MO', 'TU', 'WE', 'TH', 'FR'] : ['SA', 'SU'] } }));
rule('rec', `(?:every|each)\\s+${wdList}(?:(?:\\s*,\\s*|\\s+and\\s+|\\s*&\\s*)(?:every\\s+)?${wdList})*\\b`,
  (m) => ({ rec: { freq: 'WEEKLY', interval: 1, byday: [...new Set([...m[0].matchAll(new RegExp(`\\b(${WD_ANY})`, 'gi'))].map((x) => RR_DAY[wdIndex(x[1])]))] } }));
rule('rec', `\\b(?:on\\s+)?(?:${WD_FULL})s(?:(?:\\s*,\\s*|\\s+and\\s+|\\s*&\\s*)(?:${WD_FULL})s)*\\b`,
  (m) => ({ rec: { freq: 'WEEKLY', interval: 1, byday: [...new Set([...m[0].matchAll(new RegExp(`\\b(${WD_FULL})`, 'gi'))].map((x) => RR_DAY[wdIndex(x[1])]))] } }));
rule('rec', `(?:every|each)\\s+(morning|afternoon|evening|night)\\b`,
  (m) => ({ rec: { freq: 'DAILY', interval: 1 }, time: PART_OF_DAY[m[1].toLowerCase()], approx: true, partName: m[1].toLowerCase() }));
rule('rec', `(?:every|each)\\s+(day|week|month|year)\\b`,
  (m) => ({ rec: { freq: { day: 'DAILY', week: 'WEEKLY', month: 'MONTHLY', year: 'YEARLY' }[m[1].toLowerCase()], interval: 1 }, anchorless: true }));
rule('rec', `\\b(daily|weekly|monthly|yearly|annually|biweekly|fortnightly)\\b`,
  (m) => ({ rec: { freq: { daily: 'DAILY', weekly: 'WEEKLY', monthly: 'MONTHLY', yearly: 'YEARLY', annually: 'YEARLY', biweekly: 'WEEKLY', fortnightly: 'WEEKLY' }[m[1].toLowerCase()],
    interval: /^(biweekly|fortnightly)$/i.test(m[1]) ? 2 : 1 }, anchorless: true }));

// ---- dates ----
rule('date', `\\bday\\s+after\\s+tomorrow\\b`, (_, c) => ({ date: addDays(c.today, 2) }));
rule('date', `\\bto?m{1,2}o?r{1,2}ow\\b`, (_, c) => ({ date: addDays(c.today, 1) }));
rule('date', `\\btoday\\b`, (_, c) => ({ date: c.today }));
rule('date', `\\b(?:eod|cob)\\b`, (_, c) => ({ date: c.today }));
rule('date', `\\btonight\\b`, (_, c) => ({ date: c.today, time: '20:00', approx: true }));
rule('date', `\\b(?:(next|this|coming)\\s+)?(${WD_FULL})\\b`,
  (m, c) => ({ date: weekdayDate(c.today, wdIndex(m[2]), { next: 'nextWeek', this: 'onOrAfter', coming: 'after' }[(m[1] ?? '').toLowerCase()] ?? 'after') }));
rule('date', `\\b(tues|thurs?|thu|weds?|fri)\\b`, (m, c) => ({ date: weekdayDate(c.today, wdIndex(m[1]), 'after') }));
rule('date', `\\b(?:on|next|this)\\s+(${WD_ANY})\\b`,
  (m, c) => ({ date: weekdayDate(c.today, wdIndex(m[1]), /^next/i.test(m[0]) ? 'nextWeek' : /^this/i.test(m[0]) ? 'onOrAfter' : 'after') }));
rule('date', `\\b(this|next)\\s+weekend\\b`,
  (m, c) => ({ date: weekdayDate(c.today, 6, m[1].toLowerCase() === 'next' ? 'nextWeek' : 'onOrAfter'), approx: true }));
rule('date', `\\bin\\s+(\\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\\s+(minute|hour|day|week|month)s?\\b`, (m, c) => {
  const n = +m[1] || NUM_WORD[m[1].toLowerCase()], unit = m[2].toLowerCase();
  if (unit === 'minute' || unit === 'hour') {
    const t = c.nowMin + n * (unit === 'hour' ? 60 : 1);
    return { date: addDays(c.today, Math.floor(t / 1440)), time: hhmm(t % 1440) };
  }
  return { date: unit === 'month' ? addMonths(c.today, n) : addDays(c.today, n * (unit === 'week' ? 7 : 1)) };
});
rule('date', `\\b(?:the\\s+)?end\\s+of\\s+next\\s+(week|month|year)\\b`, (m, c) => {
  const u = m[1].toLowerCase(), y = c.today.getUTCFullYear(), mo = c.today.getUTCMonth();
  return u === 'week' ? { date: weekdayDate(c.today, 5, 'nextWeek'), approx: true }
    : { date: u === 'month' ? mk(y, mo + 2, 0) : mk(y + 1, 11, 31) };
});
rule('date', `\\bnext\\s+(week|month|year)\\b`, (m, c) => {
  const u = m[1].toLowerCase();
  return { date: u === 'week' ? weekdayDate(c.today, 1, 'after')
    : u === 'month' ? mk(c.today.getUTCFullYear(), c.today.getUTCMonth() + 1, 1) : mk(c.today.getUTCFullYear() + 1, 0, 1), approx: true };
});
rule('date', `\\b(?:the\\s+)?end\\s+of\\s+(?:the\\s+)?(day|week|month|year|${MONTH})\\b`, (m, c) => {
  const u = m[1].toLowerCase(), y = c.today.getUTCFullYear(), mo = c.today.getUTCMonth();
  if (u === 'day') return { date: c.today };
  if (u === 'week') return { date: weekdayDate(c.today, 5, 'onOrAfter'), approx: true };
  if (u === 'month') return { date: mk(y, mo + 1, 0) };
  if (u === 'year') return { date: mk(y, 11, 31) };
  const k = monthIndex(u), d = mk(y, k + 1, 0);
  return { date: d >= c.today ? d : mk(y + 1, k + 1, 0) };
});
rule('date', `\\b(\\d{4})-(\\d{2})-(\\d{2})(?:T(\\d{2}):(\\d{2}))?(?!\\d)`, (m) => ({ date: explicitDate(+m[1], +m[2] - 1, +m[3]), time: m[4] ? `${m[4]}:${m[5]}` : undefined }));
rule('date', `\\b(?:on\\s+)?(?:the\\s+)?(${MONTH})\\.?\\s+${ordinal}(?:,?\\s+(\\d{4}))?\\b(?!\\s*(?::\\d|am\\b|pm\\b))`,
  (m, c) => ({ date: m[3] ? explicitDate(+m[3], monthIndex(m[1]), +m[2]) : nextMonthDay(c.today, monthIndex(m[1]), +m[2]) }));
rule('date', `\\b(?:on\\s+)?(?:the\\s+)?${ordinal}\\s+(?:of\\s+)?(${MONTH})(?:,?\\s+(\\d{4}))?\\b`,
  (m, c) => ({ date: m[3] ? explicitDate(+m[3], monthIndex(m[2]), +m[1]) : nextMonthDay(c.today, monthIndex(m[2]), +m[1]) }));
rule('date', `\\b(\\d{1,2})/(\\d{1,2})(?:/(\\d{2,4}))?\\b(?!\\s*(?:cups?|tsp|tbsp|teaspoons?|tablespoons?|oz|ounces?|lbs?|pounds?|inch(?:es)?|miles?|of|full|empty))`, (m, c) => {
  const mo = +m[1] - 1, d = +m[2];
  if (mo > 11 || d < 1 || d > 31) return null;
  return { date: m[3] ? explicitDate(+m[3] < 100 ? 2000 + +m[3] : +m[3], mo, d) : nextMonthDay(c.today, mo, d) };
});
// Only when the ordinal ends the phrase: "the 2nd draft" and "the 7th street cafe" are not dates.
rule('date', `\\b(?:on\\s+)?the\\s+(\\d{1,2})(?:st|nd|rd|th)\\b(?=\\s*(?:$|[,.;:!?)]|\\s(?:at|by|and|or|before|after|in|for|morning|afternoon|evening)\\b))`, (m, c) => {
  const n = +m[1];
  for (let i = 0; i < 3; i++) {
    const t = addMonths(mk(c.today.getUTCFullYear(), c.today.getUTCMonth(), 1), i);
    if (n <= daysInMonth(t.getUTCFullYear(), t.getUTCMonth()) && mk(t.getUTCFullYear(), t.getUTCMonth(), n) >= c.today)
      return { date: mk(t.getUTCFullYear(), t.getUTCMonth(), n) };
  }
  return null;
});

// ---- times ----
// Nobody says "at 5" meaning 5am; 8 to 11 are the morning hours.
const bareHour = (h) => (h >= 8 && h <= 11 ? h : (h % 12) + 12);
// With a day part beside it the hour is no longer a guess: "morning at 7" is 07:00 and "evening at 7" is 19:00.
const dayPartHour = (h, part) => (part === 'morning' ? h % 12 : part === 'night' ? (h === 12 ? 0 : h >= 6 ? h + 12 : h) : h === 12 ? 12 : h + 12);
const clock = (h, min, ap) => {
  if (h < 1 || h > 12 || min > 59) return null;
  return `${pad((h % 12) + (/^p/i.test(ap) ? 12 : 0))}:${pad(min)}`;
};
rule('time', `\\b(?:at\\s+)?(\\d{1,2})(?::(\\d{2}))?\\s*(a\\.?m\\.?|p\\.?m\\.?)(?![a-z])`,
  (m) => { const t = clock(+m[1], +(m[2] ?? 0), m[3]); return t && { time: t }; });
rule('time', `\\b(at\\s+)?([01]?\\d|2[0-3]):([0-5]\\d)\\b(?!\\s*(?:am|pm|a\\.m|p\\.m))`, (m) => {
  const h = +m[2];
  // "at 5:30" is the afternoon; "17:30", "09:00" and a bare "5:30" are taken literally.
  return m[1] && h >= 1 && h <= 11 && m[2].length === (h < 10 ? 1 : 2) ? { time: `${pad(bareHour(h))}:${m[3]}`, approx: true, amb: { h, min: +m[3] } } : { time: `${pad(h)}:${m[3]}` };
});
rule('time', `\\b(\\d{1,2})\\s+(?:in\\s+the\\s+)?(morning|afternoon|evening)\\b`, (m) => {
  const h = +m[1]; if (h < 1 || h > 12) return null;
  return { time: `${pad(m[2].toLowerCase() === 'morning' ? h % 12 : (h % 12) + 12)}:00` };
});
rule('time', `\\b(?:at\\s+)?(\\d{1,2})\\s*o['\u2019]?clock\\b`, (m) => (+m[1] >= 1 && +m[1] <= 12 ? { time: `${pad(bareHour(+m[1]))}:00`, approx: true, amb: { h: +m[1], min: 0 } } : null));
rule('time', `\\bhalf\\s+past\\s+(\\d{1,2})\\b`, (m) => (+m[1] >= 1 && +m[1] <= 12 ? { time: `${pad(bareHour(+m[1]))}:30`, approx: true, amb: { h: +m[1], min: 30 } } : null));
rule('time', `\\bquarter\\s+(past|to)\\s+(\\d{1,2})\\b`, (m) => {
  const h = +m[2]; if (h < 1 || h > 12) return null;
  // Resolve the named hour first ("quarter to 8" is 07:45, as "at 8" is the morning), then step back a quarter.
  return m[1].toLowerCase() === 'past' ? { time: `${pad(bareHour(h))}:15`, approx: true, amb: { h, min: 15 } }
    : { time: hhmm((bareHour(h) * 60 - 15 + 1440) % 1440), approx: true, amb: { h, min: -15 } };
});
rule('time', `(?<=\\b(?:tomorrow|tonight|today|${WD_FULL})\\s)night\\b`, () => ({ time: PART_OF_DAY.night, approx: true, part: true, partName: 'night' }));
rule('time', `\\bat\\s+(\\d{1,2})\\b(?!\\s*(?:st|nd|rd|th|:|/|am|pm|\\d))`, (m) => {
  const h = +m[1]; if (h < 1 || h > 12) return null;
  return { time: `${pad(bareHour(h))}:00`, approx: true, amb: { h, min: 0 } };
});
rule('time', `\\b(?:at\\s+)?(noon|midday|midnight)\\b`, (m) => ({ time: /midnight/i.test(m[1]) ? '00:00' : '12:00' }));
rule('time', `\\b(?:in\\s+the\\s+)?(morning|afternoon|evening)\\b`, (m) => ({ time: PART_OF_DAY[m[1].toLowerCase()], approx: true, part: true, partName: m[1].toLowerCase() }));

const DANGLING = /(?:\s*,|\s+(?:on|at|by|due|before|until|from|starting|each))+\s*$/i;

export function parse(text, opts = {}) {
  const nowStr = opts.now ?? (() => {
    const n = new Date();
    return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}T${pad(n.getHours())}:${pad(n.getMinutes())}`;
  })();
  const ctx = { today: parseDay(nowStr.slice(0, 10)), nowMin: +nowStr.slice(11, 13) * 60 + +nowStr.slice(14, 16) };

  const found = [];
  for (const r of recognizers) {
    for (const m of text.matchAll(r.re)) {
      const data = r.fn(m, ctx);
      if (data && !('date' in data && (!data.date || Number.isNaN(+data.date)))) found.push({ kind: r.kind, start: m.index, end: m.index + m[0].length, text: m[0], data });
    }
  }
  // Longest span wins; ties go to the earlier-registered recognizer, which is the more specific one.
  const order = found.map((f, i) => [f, i]).sort(([a, i], [b, j]) => (b.end - b.start) - (a.end - a.start) || i - j).map(([f]) => f);
  const picked = [];
  for (const f of order) if (!picked.some((p) => f.start < p.end && p.start < f.end)) picked.push(f);
  picked.sort((a, b) => a.start - b.start);

  // One of each kind; later dates and times stay in the text for the model to see. Recurrence prefers the
  // span that names days ("on fridays") over a generic one ("weekly"); leftover generic ones are cut.
  const recs = picked.filter((f) => f.kind === 'rec');
  const recPick = recs.find((f) => !f.data.anchorless) ?? recs[0];
  // The first time phrase wins. A clock time beside a day part refines it: "afternoon at 4pm" is 16:00 and "morning at 7" is
  // 07:00, with only that day part consumed. A later, unrelated time ("tomorrow morning, dinner at 7pm") stays in the text.
  const times = picked.filter((f) => f.kind === 'time');
  const firstDate = picked.find((f) => f.kind === 'date');
  const adjacent = (a, b) => { const [x, y] = a.start < b.start ? [a, b] : [b, a]; return /^[\s,]*$/.test(text.slice(x.end, y.start)); };
  const head = times[0];
  const partner = head ? times.find((f) => f !== head && !!f.data.part !== !!head.data.part && adjacent(f, head)) : undefined;
  const firstTime = partner && head.data.part ? partner : head;
  const dayPart = partner ? (head.data.part ? head : partner) : undefined;
  const used = picked.filter((f) => f === firstDate || f === firstTime || f === recPick || (f.kind === 'rec' && f.data.anchorless) || f === dayPart);
  // A generic phrase beside a specific one still counts: "biweekly on mondays" keeps its interval.
  const generic = recs.filter((f) => f !== recPick && f.data.anchorless && f.data.rec.freq === recPick?.data.rec.freq);
  const rec = recPick ? { ...recPick.data.rec, interval: Math.max(recPick.data.rec.interval, ...generic.map((f) => f.data.rec.interval)) } : null;
  let date = firstDate?.data.date ?? null;
  let time = firstTime?.data.time ?? firstDate?.data.time ?? recPick?.data.time ?? null;
  // "every morning at 7": the day part sits inside the repeat span and settles the hour the same way.
  const partName = dayPart?.data.partName
    ?? (recPick?.data.partName && firstTime && !firstTime.data.part && adjacent(recPick, firstTime) ? recPick.data.partName : undefined);
  const resolvedByDayPart = !!(partName && firstTime?.data.amb);
  if (resolvedByDayPart) time = hhmm((dayPartHour(firstTime.data.amb.h, partName) * 60 + firstTime.data.amb.min + 1440) % 1440);
  // A repeat's own default time ("every morning" is 09:00) is only a guess when no clock time was given.
  const approx = [firstDate, resolvedByDayPart ? null : firstTime, firstTime ? null : recPick].some((f) => f?.data.approx) || !!recPick?.data.anchorless;

  const afterNow = (d) => +d > +ctx.today || time == null || +time.slice(0, 2) * 60 + +time.slice(3) > ctx.nowMin;
  if (rec) {
    // The first occurrence is the first day the rule allows on or after the start: an explicit "starting
    // tomorrow" is the lower bound, otherwise today (which only counts while its time is still ahead).
    const from = date ?? ctx.today;
    for (let i = 0; i < 800; i++) {
      const d = addDays(from, i);
      if (matchesRule(rec, d) && (+d !== +ctx.today || afterNow(d))) { date = d; break; }
    }
  } else if (!date && time) {
    date = afterNow(ctx.today) ? ctx.today : addDays(ctx.today, 1);
  }

  const cuts = used.map((f) => ({ start: f.start, end: f.end })).map((c) => {
    const m = DANGLING.exec(text.slice(0, c.start));
    return m ? { start: c.start - m[0].length, end: c.end } : c;
  }).sort((a, b) => a.start - b.start);
  let rest = '', at = 0;
  for (const c of cuts) { if (c.start >= at) rest += text.slice(at, c.start) + ' '; at = Math.max(at, c.end); }
  rest = (rest + text.slice(at)).replace(/\s+/g, ' ').replace(/\s+([,.;!?])/g, '$1').replace(/^[\s,.;:!\u2014\u2013-]+|[\s,.;:!\u2014\u2013-]+$/g, '');

  return {
    date: date ? ymd(date) : null, time, recurrence: rec ? buildRule(rec) : null, approx,
    rest, spans: used.map((f) => ({ kind: f.kind, text: f.text })),
  };
}

function parseDay(s) { const [y, m, d] = s.split('-').map(Number); return mk(y, m - 1, d); }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const line of process.argv.slice(2)) console.log(JSON.stringify({ in: line, ...parse(line) }, null, 2));
}
