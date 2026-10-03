import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runRow, type Outcome } from './harness';
import { ROWS } from './rows';
import { APPROVED_DIFFERENCES } from './approved';
import { renderMatrix } from './render';

const file = fileURLToPath(new URL('./legacy-outcomes.json', import.meta.url));
/**
 * Error wording is informational: an adapter reports the same refusal in its own words. What must
 * match is that it fails, on the same channel, with the same writes (usually none).
 */
const comparable = (outcome: Outcome) => outcome.result.ok ? outcome
  : { ...outcome, result: { ok: false, channel: outcome.result.channel } };
const docFile = fileURLToPath(new URL('../../../docs/plans/mcp-parity-matrix.md', import.meta.url));
const START = '<!-- matrix:start -->', END = '<!-- matrix:end -->';
const record = process.env.PARITY_RECORD === '1';

describe('parity matrix', () => {
  it('has unique row ids and covers every retained mutating tool', () => {
    expect(new Set(ROWS.map(r => r.id)).size).toBe(ROWS.length);
    expect(new Set(ROWS.map(r => r.tool))).toEqual(new Set(['add_task', 'complete_task', 'defer_task', 'update_task', 'reopen_task', 'focus_task', 'delete_task', 'create_project', 'update_project', 'delete_project', 'link_tasks', 'unlink_tasks', 'update_preference']));
  });

  if (record) {
    it('records legacy outcomes', async () => {
      const recorded: Record<string, Outcome> = {};
      for (const r of ROWS) recorded[r.id] = await runRow(r);
      writeFileSync(file, JSON.stringify(recorded, null, 1) + '\n');
      const doc = readFileSync(docFile, 'utf8');
      const head = doc.slice(0, doc.indexOf(START) + START.length), tail = doc.slice(doc.indexOf(END));
      writeFileSync(docFile, `${head}\n\n${renderMatrix(ROWS, recorded, APPROVED_DIFFERENCES)}\n${tail}`);
    }, 120_000);
    return;
  }
  const pinned: Record<string, Outcome> = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};

  it('pins an outcome for every row and none for removed rows', () => {
    expect(Object.keys(pinned).sort()).toEqual(ROWS.map(r => r.id).sort());
  });
  it('lists approved differences only for existing rows, each with a reason', () => {
    for (const [id, diff] of Object.entries(APPROVED_DIFFERENCES)) { expect(pinned[id], id).toBeDefined(); expect(diff.reason.length, id).toBeGreaterThan(20); }
  });
  it('keeps the generated table in docs/plans/mcp-parity-matrix.md current', () => {
    const doc = readFileSync(docFile, 'utf8');
    const body = doc.slice(doc.indexOf(START) + START.length, doc.indexOf(END));
    expect(body.trim()).toBe(renderMatrix(ROWS, pinned, APPROVED_DIFFERENCES).trim());
  });
  describe.each(ROWS)('$id', r => {
    it(r.note, async () => {
      const actual = await runRow(r);
      const approved = APPROVED_DIFFERENCES[r.id];
      expect(comparable(actual)).toEqual(comparable(approved ? approved.outcome : pinned[r.id]!));
    });
  });
});
