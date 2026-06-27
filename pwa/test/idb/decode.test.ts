import { describe, test, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { resetIdb } from '../helpers/idb';
import { closeDb, getDB } from '../../src/idb/db';
import { idbGetAllTasks } from '../../src/idb/tasks';
import { idbGetAllProjects } from '../../src/idb/projects';
import { idbGetAllLinks } from '../../src/idb/links';
import { decodeTaskRows, decodeProjectRows, decodeLinkRows, onDecodeReport } from '../../src/idb/decode';
import { makeTask, makeProject, makeLink } from '../helpers/fixtures';

beforeEach(async () => {
  closeDb();
  await resetIdb();
  onDecodeReport(() => {});
});

// ── decodeTaskRows ────────────────────────────────────────────────────────────

describe('decodeTaskRows — round-trip', () => {
  test('valid rows decode clean, report empty', () => {
    const task = makeTask({ id: 't_aaa001' });
    const { rows, report } = decodeTaskRows([task]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('t_aaa001');
    expect(report.repaired).toBe(0);
    expect(report.quarantined).toHaveLength(0);
  });

  test('multiple valid rows all pass', () => {
    const tasks = [
      makeTask({ id: 't_aaa001' }),
      makeTask({ id: 't_bbb001', status: 'done' }),
      makeTask({ id: 't_ccc001', defer_kind: 'someday' }),
    ];
    const { rows, report } = decodeTaskRows(tasks);
    expect(rows).toHaveLength(3);
    expect(report.repaired).toBe(0);
    expect(report.quarantined).toHaveLength(0);
  });
});

describe('decodeTaskRows — missing nullable fields repair', () => {
  test('task missing notes field is repaired (nullable field added later)', () => {
    const old = { ...makeTask({ id: 't_aaa001' }) };
    delete (old as Record<string, unknown>)['notes'];
    const { rows, report } = decodeTaskRows([old]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.notes).toBeNull();
    expect(report.repaired).toBe(1);
    expect(report.quarantined).toHaveLength(0);
  });

  test('task missing kickoff_note and session_log is repaired', () => {
    const old = { ...makeTask({ id: 't_aaa001' }) };
    delete (old as Record<string, unknown>)['kickoff_note'];
    delete (old as Record<string, unknown>)['session_log'];
    const { rows, report } = decodeTaskRows([old]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kickoff_note).toBeNull();
    expect(rows[0]!.session_log).toBeNull();
    expect(report.repaired).toBe(1);
  });
});

describe('decodeTaskRows — legacy repair', () => {
  test('snoozed_until era task is repaired and counted', () => {
    const legacy = {
      ...makeTask({ id: 't_aaa001' }),
      snoozed_until: '2026-07-01T09:00:00.000Z',
      defer_until: undefined,
      defer_kind: undefined,
    };
    const { rows, report, repairedRows } = decodeTaskRows([legacy]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.defer_kind).toBe('until');
    expect(rows[0]!.defer_until).toBe('2026-07-01T09:00:00.000Z');
    expect(report.repaired).toBe(1);
    expect(report.quarantined).toHaveLength(0);
    expect(repairedRows).toHaveLength(1);
  });

  test('snoozed_until null is repaired to defer_kind none', () => {
    const legacy = {
      ...makeTask({ id: 't_aaa001' }),
      snoozed_until: null,
      defer_until: undefined,
      defer_kind: undefined,
    };
    const { rows, report } = decodeTaskRows([legacy]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.defer_kind).toBe('none');
    expect(rows[0]!.defer_until).toBeNull();
    expect(report.repaired).toBe(1);
  });
});

describe('decodeTaskRows — field-level quarantine', () => {
  test('invalid status quarantines the row', () => {
    const bad = { ...makeTask({ id: 't_aaa001' }), status: 'archived' };
    const { rows, report } = decodeTaskRows([bad]);
    expect(rows).toHaveLength(0);
    expect(report.quarantined).toHaveLength(1);
    expect(report.quarantined[0]!.key).toBe('t_aaa001');
    expect(report.quarantined[0]!.store).toBe('tasks');
  });

  test('invalid updated_at quarantines the row', () => {
    const bad = { ...makeTask({ id: 't_aaa001' }), updated_at: 'yesterday' };
    const { rows, report } = decodeTaskRows([bad]);
    expect(rows).toHaveLength(0);
    expect(report.quarantined).toHaveLength(1);
  });

  test('quarantined rows are excluded but report lists their key and issues', () => {
    const bad = { ...makeTask({ id: 't_aaa001' }), status: 'archived' };
    const { rows, report } = decodeTaskRows([bad, makeTask({ id: 't_bbb001' })]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('t_bbb001');
    expect(report.quarantined).toHaveLength(1);
    expect(report.quarantined[0]!.issues.length).toBeGreaterThan(0);
  });
});

describe('decodeTaskRows — cross-field quarantine', () => {
  test('defer_kind=until with defer_until=null quarantines', () => {
    const bad = makeTask({ id: 't_aaa001', defer_kind: 'until', defer_until: null });
    const { rows, report } = decodeTaskRows([bad]);
    expect(rows).toHaveLength(0);
    expect(report.quarantined[0]!.issues[0]!.code).toBe('required');
  });

  test('defer_kind=none with non-null defer_until quarantines', () => {
    const bad = makeTask({ id: 't_aaa001', defer_kind: 'none', defer_until: '2026-07-01T09:00:00.000Z' });
    const { rows, report } = decodeTaskRows([bad]);
    expect(rows).toHaveLength(0);
    expect(report.quarantined[0]!.issues[0]!.code).toBe('invalid_state');
  });

  test('recurrence set with due_date=null quarantines', () => {
    const bad = makeTask({ id: 't_aaa001', recurrence: 'FREQ=DAILY', due_date: null });
    const { rows, report } = decodeTaskRows([bad]);
    expect(rows).toHaveLength(0);
    expect(report.quarantined[0]!.issues[0]!.path).toEqual(['due_date']);
  });

  test('done task with future focused_until quarantines', () => {
    const bad = makeTask({ id: 't_aaa001', status: 'done', focused_until: '2099-01-01T00:00:00.000Z' });
    const { rows, report } = decodeTaskRows([bad]);
    expect(rows).toHaveLength(0);
    expect(report.quarantined[0]!.issues[0]!.path).toEqual(['focused_until']);
  });

  test('deferred task with focused_until quarantines', () => {
    const bad = makeTask({
      id: 't_aaa001',
      defer_kind: 'until',
      defer_until: '2026-07-01T09:00:00.000Z',
      focused_until: '2026-07-02T09:00:00.000Z',
    });
    const { rows, report } = decodeTaskRows([bad]);
    expect(rows).toHaveLength(0);
    expect(report.quarantined[0]!.issues[0]!.path).toEqual(['focused_until']);
  });
});

describe('decodeTaskRows — mixed store', () => {
  test('2 valid + 1 reparable + 1 junk → 3 returned', () => {
    const valid1 = makeTask({ id: 't_aaa001' });
    const valid2 = makeTask({ id: 't_bbb001' });
    const reparable = { ...makeTask({ id: 't_ccc001' }), snoozed_until: null, defer_until: undefined, defer_kind: undefined };
    const junk = { ...makeTask({ id: 't_ddd001' }), status: 'archived' };
    const { rows, report } = decodeTaskRows([valid1, valid2, reparable, junk]);
    expect(rows).toHaveLength(3);
    expect(rows.map(r => r.id).sort()).toEqual(['t_aaa001', 't_bbb001', 't_ccc001']);
    expect(report.repaired).toBe(1);
    expect(report.quarantined).toHaveLength(1);
    expect(report.quarantined[0]!.key).toBe('t_ddd001');
  });
});

// ── decodeProjectRows ─────────────────────────────────────────────────────────

describe('decodeProjectRows', () => {
  test('valid project decodes clean', () => {
    const project = makeProject({ id: 'p_aaa001' });
    const { rows, report } = decodeProjectRows([project]);
    expect(rows).toHaveLength(1);
    expect(report.quarantined).toHaveLength(0);
  });

  test('project missing notes field is repaired (nullable field added later)', () => {
    // Simulate a row written before the notes column was added
    const old = { ...makeProject({ id: 'p_aaa001' }) };
    delete (old as Record<string, unknown>)['notes'];
    const { rows, report } = decodeProjectRows([old]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.notes).toBeNull();
    expect(report.repaired).toBe(1);
    expect(report.quarantined).toHaveLength(0);
  });

  test('project missing kickoff_note field is repaired', () => {
    const old = { ...makeProject({ id: 'p_aaa001' }) };
    delete (old as Record<string, unknown>)['kickoff_note'];
    const { rows, report } = decodeProjectRows([old]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kickoff_note).toBeNull();
    expect(report.repaired).toBe(1);
  });

  test('invalid status quarantines the project row', () => {
    const bad = { ...makeProject({ id: 'p_aaa001' }), status: 'deleted' };
    const { rows, report } = decodeProjectRows([bad]);
    expect(rows).toHaveLength(0);
    expect(report.quarantined).toHaveLength(1);
    expect(report.quarantined[0]!.key).toBe('p_aaa001');
    expect(report.quarantined[0]!.store).toBe('projects');
  });
});

// ── decodeLinkRows ────────────────────────────────────────────────────────────

describe('decodeLinkRows', () => {
  test('valid link decodes clean', () => {
    const link = makeLink();
    const { rows, report } = decodeLinkRows([link]);
    expect(rows).toHaveLength(1);
    expect(report.quarantined).toHaveLength(0);
  });

  test('invalid link_type quarantines the link row', () => {
    const bad = { ...makeLink(), link_type: 'hates' };
    const { rows, report } = decodeLinkRows([bad]);
    expect(rows).toHaveLength(0);
    expect(report.quarantined).toHaveLength(1);
    expect(report.quarantined[0]!.store).toBe('links');
    // Key for a link is a [from, to, type] tuple
    expect(Array.isArray(report.quarantined[0]!.key)).toBe(true);
  });
});

// ── onDecodeReport callback ───────────────────────────────────────────────────

describe('onDecodeReport callback', () => {
  test('callback fires when rows are quarantined', () => {
    const reports: import('../../src/idb/decode').DecodeReport[] = [];
    onDecodeReport(r => reports.push(r));
    const bad = { ...makeTask({ id: 't_aaa001' }), status: 'archived' };
    decodeTaskRows([bad]);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.quarantined).toHaveLength(1);
  });

  test('callback fires when rows are repaired', () => {
    const reports: import('../../src/idb/decode').DecodeReport[] = [];
    onDecodeReport(r => reports.push(r));
    const legacy = { ...makeTask({ id: 't_aaa001' }), snoozed_until: null, defer_until: undefined, defer_kind: undefined };
    decodeTaskRows([legacy]);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.repaired).toBe(1);
  });

  test('callback does not fire for a fully clean decode', () => {
    const reports: import('../../src/idb/decode').DecodeReport[] = [];
    onDecodeReport(r => reports.push(r));
    decodeTaskRows([makeTask({ id: 't_aaa001' })]);
    expect(reports).toHaveLength(0);
  });
});

// ── IDB write-back of repaired rows ──────────────────────────────────────────

describe('idbGetAllTasks — write-back on repair', () => {
  test('repaired task is written back so second read needs no repair', async () => {
    // Seed a legacy snoozed_until task directly
    const db = await getDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('tasks', 'readwrite');
      tx.objectStore('tasks').put({
        ...makeTask({ id: 't_aaa001' }),
        snoozed_until: '2026-08-01T09:00:00.000Z',
        defer_until: undefined,
        defer_kind: undefined,
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    let reports: import('../../src/idb/decode').DecodeReport[] = [];
    onDecodeReport(r => reports.push(r));

    // First read: should repair and write back
    const rows1 = await idbGetAllTasks();
    expect(rows1).toHaveLength(1);
    expect(rows1[0]!.defer_kind).toBe('until');
    expect(reports[0]!.repaired).toBe(1);

    // Reset report accumulator
    reports = [];

    // Second read: raw row is now canonical, no repair needed
    const rows2 = await idbGetAllTasks();
    expect(rows2).toHaveLength(1);
    expect(rows2[0]!.defer_kind).toBe('until');
    expect(reports).toHaveLength(0);
  });

  test('quarantined task is excluded from state but stays in IDB store', async () => {
    const db = await getDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('tasks', 'readwrite');
      tx.objectStore('tasks').put({ ...makeTask({ id: 't_bad001' }), status: 'archived' });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    const rows = await idbGetAllTasks();
    expect(rows).toHaveLength(0);

    // Raw store still has the record
    const raw = await new Promise<unknown[]>((resolve, reject) => {
      const req = db.transaction('tasks', 'readonly').objectStore('tasks').getAll();
      req.onsuccess = () => resolve(req.result as unknown[]);
      req.onerror = () => reject(req.error);
    });
    expect(raw).toHaveLength(1);
  });
});

// ── Boot integration ──────────────────────────────────────────────────────────

describe('boot integration', () => {
  test('seeded drifted store → only valid rows returned, report callback fired', async () => {
    const db = await getDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['tasks', 'projects', 'links'], 'readwrite');
      // valid task
      tx.objectStore('tasks').put(makeTask({ id: 't_aaa001' }));
      // quarantined task
      tx.objectStore('tasks').put({ ...makeTask({ id: 't_bad001' }), status: 'archived' });
      // valid project
      tx.objectStore('projects').put(makeProject({ id: 'p_aaa001' }));
      // quarantined project
      tx.objectStore('projects').put({ ...makeProject({ id: 'p_bad001' }), status: 'deleted' });
      // valid link
      tx.objectStore('links').put(makeLink({ from_task_id: 't_aaa001', to_task_id: 't_aaa002', link_type: 'blocks' }));
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    const reports: import('../../src/idb/decode').DecodeReport[] = [];
    onDecodeReport(r => reports.push(r));

    const [tasks, projects, links] = await Promise.all([
      idbGetAllTasks(),
      idbGetAllProjects(),
      idbGetAllLinks(),
    ]);

    // Only valid rows in state
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.id).toBe('t_aaa001');
    expect(projects).toHaveLength(1);
    expect(projects[0]!.id).toBe('p_aaa001');
    expect(links).toHaveLength(1);

    // Report callback fired (once per store that had issues)
    const totalQuarantined = reports.reduce((acc, r) => acc + r.quarantined.length, 0);
    expect(totalQuarantined).toBe(2);
  });
});
