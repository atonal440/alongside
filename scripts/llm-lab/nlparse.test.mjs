// node --test scripts/llm-lab/nlparse.test.mjs
// The cases live in fixtures/parse-cases.json so the Kotlin port (app/.../QuickAddParserTest) runs the very
// same table. Each row: input, expected date/time/recurrence/rest, and an optional local "now"; rows
// without one use the file's default, Sunday 2026-10-25 10:58 (Mon 26, Tue 27, Wed 28, Thu 29, Fri 30,
// Sat 31, Sun Nov 1). The first 35 rows were written while building the parser; the rest were written
// blind afterwards, include lookalikes that must NOT parse, and drove the second round of fixes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from './nlparse.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/parse-cases.json', import.meta.url), 'utf8'));

for (const c of fixture.cases) {
  test(`${c.in}${c.now ? `  [now ${c.now}]` : ''}`, () => {
    const p = parse(c.in, { now: c.now ?? fixture.now });
    assert.deepEqual({ date: p.date, time: p.time, recurrence: p.recurrence, rest: p.rest },
      { date: c.date, time: c.time, recurrence: c.recurrence, rest: c.rest });
  });
}

test('vague phrases are flagged approximate, precise ones are not', () => {
  const now = fixture.now;
  assert.equal(parse('lunch tomorrow morning', { now }).approx, true);
  assert.equal(parse('lunch tomorrow at 9am', { now }).approx, false);
  assert.equal(parse('call at 5', { now }).approx, true);
});

test('"next" means the following Monday-to-Sunday week; "this" is the upcoming one', () => {
  const wed = { now: '2026-10-28T10:00' };
  assert.equal(parse('book flights next friday', wed).date, '2026-11-06');
  assert.equal(parse('book flights this friday', wed).date, '2026-10-30');
  assert.equal(parse('book flights friday', wed).date, '2026-10-30');
  assert.equal(parse('book flights wednesday', wed).date, '2026-11-04');
});
