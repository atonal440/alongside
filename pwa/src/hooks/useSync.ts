import { useEffect } from 'react';
import { useAppState } from './useAppState';
import { flushPendingOps, syncFromServer } from '../api/sync';
import { registerSyncCallback } from '../context/actions';

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
        const result = await syncFromServer(config);

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
