// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

const flushPendingOps = vi.fn();
const refreshFromCanonical = vi.fn();
const loadView = vi.fn();
const dispatch = vi.fn();

vi.mock('../../src/api/sync', () => ({ flushPendingOps: (...a: unknown[]) => flushPendingOps(...a) }));
vi.mock('../../src/sync/refresh', () => ({ refreshFromCanonical: (...a: unknown[]) => refreshFromCanonical(...a) }));
vi.mock('../../src/sync/view', () => ({ loadView: (...a: unknown[]) => loadView(...a) }));
vi.mock('../../src/hooks/useAppState', () => ({
  useAppState: () => ({ state: { apiBase: 'http://localhost:8787', authToken: 'tok' }, dispatch }),
}));

import { useSync } from '../../src/hooks/useSync';

const wrapper = ({ children }: { children: ReactNode }) => <>{children}</>;

beforeEach(() => {
  vi.clearAllMocks();
  loadView.mockResolvedValue({ tasks: [], projects: [], links: [] });
  refreshFromCanonical.mockResolvedValue({ online: true, tasks: [], projects: [], links: [] });
});

describe('useSync', () => {
  it('pulls after a flush that completed', async () => {
    flushPendingOps.mockResolvedValue({ flushed: 1, rejected: [], halted: false, unrecorded: false });
    renderHook(() => useSync(), { wrapper });
    await waitFor(() => expect(dispatch).toHaveBeenCalledWith({ type: 'SET_SYNC_STATUS', status: 'online' }));
    expect(refreshFromCanonical).toHaveBeenCalledTimes(1);
  });

  it('does not pull while a send is unresolved, but still shows the stored view with the queue replayed', async () => {
    flushPendingOps.mockResolvedValue({ flushed: 0, rejected: [], halted: true, unrecorded: false });
    renderHook(() => useSync(), { wrapper });
    await waitFor(() => expect(dispatch).toHaveBeenCalledWith({ type: 'SET_SYNC_STATUS', status: 'offline' }));
    expect(refreshFromCanonical).not.toHaveBeenCalled();
    expect(loadView).toHaveBeenCalledWith('http://localhost:8787');
    expect(dispatch).toHaveBeenCalledWith({ type: 'SET_DATA', tasks: [], projects: [], links: [] });
  });

  it('still pulls when a halted flush accepted an op that left no ledger entry', async () => {
    flushPendingOps.mockResolvedValue({ flushed: 1, rejected: [], halted: true, unrecorded: true });
    renderHook(() => useSync(), { wrapper });
    await waitFor(() => expect(refreshFromCanonical).toHaveBeenCalledTimes(1));
    expect(loadView).not.toHaveBeenCalled();
  });
});
