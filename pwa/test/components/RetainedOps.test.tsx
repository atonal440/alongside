// @vitest-environment jsdom
import { describe, test, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { resetIdb } from '../helpers/idb';
import { renderWithState } from '../helpers/renderWithState';
import { closeDb } from '../../src/idb/db';
import { idbRetainOp, idbGetRetainedOps } from '../../src/idb/retainedOps';
import { RetainedOps } from '../../src/components/layout/RetainedOps';
import type { PendingOp } from '../../src/api/pendingOps';

beforeEach(async () => { closeDb(); await resetIdb(); });

describe('RetainedOps', () => {
  test('renders nothing when there is nothing retained', async () => {
    const { container } = renderWithState(<RetainedOps />);
    await new Promise(r => setTimeout(r, 20));
    expect(container).toBeEmptyDOMElement();
  });

  test('lists refused changes and discards on request', async () => {
    await idbRetainOp({ op: 'task.complete', taskId: 't_abc001', created_at: '2026-10-02T09:00:00.000Z', attempts: 0 } as PendingOp, { kind: 'rejected', status: 409, message: 'stale' });
    renderWithState(<RetainedOps />);
    expect(await screen.findByText('Needs attention (1)')).toBeTruthy();
    expect(screen.getByText('stale')).toBeTruthy();
    await userEvent.click(screen.getByText('Discard'));
    await waitFor(async () => expect(await idbGetRetainedOps()).toEqual([]));
    await waitFor(() => expect(screen.queryByText('Needs attention (1)')).toBeNull());
  });
});
