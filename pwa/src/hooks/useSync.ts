import { useEffect } from 'react';
import { useAppState } from './useAppState';
import { flushPendingOps } from '../api/sync';
import { refreshFromCanonical, type RefreshResult } from '../sync/refresh';
import { loadView } from '../sync/view';
import { consumeUpgradeRequired } from '../api/client';
import { registerSyncCallback } from '../context/actions';

// The stored workspace with the queue replayed, for a cycle that must not pull.
async function localView(source: string): Promise<RefreshResult> {
  const view = await loadView(source);
  return { online: true, tasks: view.tasks, projects: view.projects, links: view.links };
}

export function useSync() {
  const { state, dispatch } = useAppState();
  const { apiBase, authToken } = state;

  useEffect(() => {
    if (!apiBase || !authToken) {
      dispatch({ type: 'SET_SYNC_STATUS', status: 'idle' });
      return;
    }

    const config = { apiBase, authToken };

    async function doSync() {
      dispatch({ type: 'SET_SYNC_STATUS', status: 'syncing' });
      try {
        const flush = await flushPendingOps(config);
        // No pull while a send is unresolved: a command the server committed but whose reply was lost
        // would be absorbed into the canonical copy while still queued, and the revision predicted for
        // the next write would count it twice. The next cycle pulls once the queue has flushed.
        const result = flush.halted ? await localView(config.apiBase) : await refreshFromCanonical(config);

        if (result.online && result.tasks) {
          dispatch({
            type: 'SET_DATA',
            tasks: result.tasks,
            projects: result.projects ?? [],
            links: result.links ?? [],
          });
          dispatch({ type: 'SET_SYNC_STATUS', status: flush.halted ? 'offline' : 'online' });
        } else {
          dispatch({ type: 'SET_SYNC_STATUS', status: 'offline' });
        }

        if (consumeUpgradeRequired()) {
          dispatch({ type: 'SET_TOAST', message: 'A newer version of Alongside is required. Reload the app to update; your changes are kept.' });
        }

        // Toast rejection messages after the resync so server truth is already
        // restored when the user reads the message.
        for (const message of flush.rejected) {
          dispatch({ type: 'SET_TOAST', message });
        }
      } catch (err) {
        console.warn('Sync error:', err);
        dispatch({ type: 'SET_SYNC_STATUS', status: 'offline' });
      }
    }

    // Register so that action creators can trigger a resync on durable rejection.
    registerSyncCallback(doSync);
    doSync();
    const interval = setInterval(doSync, 30_000);

    const handleSWMessage = (e: MessageEvent) => {
      if (e.data?.type === 'sync-requested') doSync();
    };
    navigator.serviceWorker?.addEventListener('message', handleSWMessage);

    return () => {
      clearInterval(interval);
      navigator.serviceWorker?.removeEventListener('message', handleSWMessage);
    };
  }, [apiBase, authToken, dispatch]);
}
