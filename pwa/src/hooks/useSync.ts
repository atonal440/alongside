import { useEffect } from 'react';
import { useAppState } from './useAppState';
import { flushPendingOps, syncFromServer } from '../api/sync';

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
        await flushPendingOps(config);
        const result = await syncFromServer(config);
        if (result.online && result.tasks) {
          dispatch({
            type: 'SET_DATA',
            tasks: result.tasks,
            projects: result.projects ?? [],
            links: result.links ?? [],
            duties: result.duties ?? [],
          });
          dispatch({ type: 'SET_SYNC_STATUS', status: 'online' });
        } else {
          dispatch({ type: 'SET_SYNC_STATUS', status: 'offline' });
        }
      } catch (err) {
        console.warn('Sync error:', err);
        dispatch({ type: 'SET_SYNC_STATUS', status: 'offline' });
      }
    }

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
