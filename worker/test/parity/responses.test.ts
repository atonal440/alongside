import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import { TOOL_RESPONSE_SCHEMAS, type ReceiptTool } from '@shared/wire/receipts';
import { runRow } from './harness';
import { ROWS } from './rows';

/** The receipt response codecs must accept every success response a legacy handler produces. */
describe('receipt response codecs vs the parity matrix', () => {
  it.each(ROWS)('$id', async row => {
    const { result } = await runRow(row, { normalize: false });
    if (!result.ok) return;
    const parsed = v.safeParse(TOOL_RESPONSE_SCHEMAS[row.tool as ReceiptTool], result.response);
    expect(parsed.success, JSON.stringify(parsed.issues?.slice(0, 2))).toBe(true);
  });
});
