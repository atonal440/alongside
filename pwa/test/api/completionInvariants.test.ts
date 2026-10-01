import { expect, it } from 'vitest';
import { parseChangesPreview, parseChangesResult } from '@shared/wire/commands';

const now = '2026-10-01T10:00:00.123Z';
const earlier = '2026-09-01T10:00:00Z';
const source = {
  id: 't_source1', title: 'Recurring source', notes: 'Notes', kickoff_note: 'Old kickoff',
  status: 'pending', task_type: 'plan', project_id: 'p_source1',
  due_date: '2026-10-05T12:00:00Z', due_all_day: null, recurrence: 'FREQ=WEEKLY',
  defer_kind: 'until', defer_until: '2026-10-03T10:00:00Z', focused_until: null,
  session_log: 'New kickoff', duty_id: null, occurrence_at: null, created_at: earlier, updated_at: earlier,
};
const completed = { ...source, status: 'done', defer_kind: 'none', defer_until: null, updated_at: now };
const successor = {
  ...source, id: 't_next001', status: 'pending', due_date: '2026-10-12T12:00:00Z', due_all_day: true,
  defer_kind: 'none', defer_until: null, kickoff_note: source.session_log, session_log: null,
  created_at: now, updated_at: now,
};
const rootDiff = { entity: 'task', id: source.id, before: { row: source, revision: 4 }, after: { row: completed, revision: 5 } };
const nextDiff = { entity: 'task', id: successor.id, before: null, after: { row: successor, revision: 1 } };
const otherRow = { ...source, id: 't_other01', recurrence: null, due_date: null, due_all_day: null };
const otherDiff = { entity: 'task', id: otherRow.id, before: { row: otherRow, revision: 1 }, after: { row: { ...otherRow, title: 'Edited' }, revision: 2 } };
const receipt = { contractVersion: 2, commandId: 'c_invariant1', payloadHash: 'a'.repeat(64), serverNow: now,
  applied: true, warnings: [], refs: { next: successor.id }, changes: [rootDiff, nextDiff] };

function accepted(changes: unknown[], grouped: boolean, refs: Record<string, string> = receipt.refs) {
  const body = { ...receipt, refs, changes: grouped ? [...changes, otherDiff] : changes,
    ...(grouped ? { batch: true, changeGroups: [changes.length, 1] } : {}) };
  const { applied: _applied, ...preview } = body;
  return [parseChangesResult(body).ok, parseChangesPreview({ ...preview, dryRun: true, requiredStatements: 10 }).ok];
}

it.each([false, true])('accepts exact completion effects (grouped=%s)', grouped => {
  expect(accepted([rootDiff, nextDiff], grouped)).toEqual([true, true]);
  const oneShot = { ...source, recurrence: null, focused_until: '2026-10-01T11:00:00Z', defer_kind: 'none', defer_until: null };
  const diff = { ...rootDiff, before: { ...rootDiff.before, row: oneShot },
    after: { ...rootDiff.after, row: { ...oneShot, status: 'done', focused_until: null, updated_at: now } } };
  expect(accepted([diff], grouped, {})).toEqual([true, true]);
  expect(accepted([rootDiff], grouped, {})).toEqual([false, false]);
  expect(accepted([diff, nextDiff], grouped)).toEqual([false, false]);
});

const completedPatches = [
  { title: 'Changed' }, { notes: null }, { project_id: null }, { task_type: 'action' },
  { kickoff_note: null }, { session_log: null }, { recurrence: 'FREQ=DAILY' },
  { due_date: '2026-10-06T12:00:00Z' }, { due_all_day: true }, { defer_kind: 'someday' },
  { defer_until: source.defer_until }, { focused_until: '2026-10-01T11:00:00Z' },
  { created_at: now }, { updated_at: earlier }, { duty_id: 'd_other01' },
  { occurrence_at: '2026-10-01T10:00:00Z' },
];
const successorPatches = [
  { title: 'Changed' }, { notes: null }, { project_id: null }, { task_type: 'action' },
  { kickoff_note: source.kickoff_note }, { session_log: source.session_log }, { recurrence: 'FREQ=DAILY' },
  { due_date: source.due_date }, { due_all_day: null }, { defer_kind: 'someday' },
  { defer_until: source.defer_until }, { focused_until: '2026-10-01T11:00:00Z' },
  { created_at: earlier }, { updated_at: earlier }, { duty_id: 'd_other01' },
  { occurrence_at: '2026-10-01T10:00:00Z' },
];
it.each(completedPatches.map(patch => ({ patch })))('rejects altered completed fields $patch', ({ patch }) => {
  for (const grouped of [false, true]) {
    expect(accepted([{ ...rootDiff, after: { ...rootDiff.after, row: { ...completed, ...patch } } }, nextDiff], grouped)).toEqual([false, false]);
    const oneShot = { ...rootDiff, before: { ...rootDiff.before, row: { ...source, recurrence: null } },
      after: { ...rootDiff.after, row: { ...completed, recurrence: null, ...patch } } };
    expect(accepted([oneShot], grouped, {})).toEqual([false, false]);
  }
});
it.each(successorPatches.map(patch => ({ patch })))('rejects altered successor fields $patch', ({ patch }) => {
  for (const grouped of [false, true]) {
    expect(accepted([rootDiff, { ...nextDiff, after: { ...nextDiff.after, row: { ...successor, ...patch } } }], grouped)).toEqual([false, false]);
  }
});
it.each([null, ''])('preserves kickoff fallback with session log %s', sessionLog => {
  const row = { ...source, session_log: sessionLog };
  const changes = [{ ...rootDiff, before: { ...rootDiff.before, row }, after: { ...rootDiff.after, row: { ...completed, session_log: sessionLog } } },
    { ...nextDiff, after: { ...nextDiff.after, row: { ...successor, kickoff_note: sessionLog ?? source.kickoff_note } } }];
  expect(accepted(changes, true)).toEqual([true, true]);
});
