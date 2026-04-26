import { useEffect } from 'react';
import { useAppState } from './useAppState';
import type { AppState } from '../context/reducer';
import { idbGetAllTasks } from '../idb/tasks';

interface HistoryState {
  view: AppState['currentView'] | 'session';
  detailId: string | null;
  editId: string | null;
}

export function pushNav(state: HistoryState) {
  history.pushState({ ...state, view: normalizeView(state.view) }, '');
}

export function replaceNav(state: HistoryState) {
  history.replaceState({ ...state, view: normalizeView(state.view) }, '');
}

function normalizeView(view: HistoryState['view'] | undefined): AppState['currentView'] {
  if (view === 'session') return 'review';
  return view ?? 'suggest';
}

export function useHistory() {
  const { state, dispatch } = useAppState();

  // Sync history on view changes
  useEffect(() => {
    const current = history.state as HistoryState | null;
    if (!current) {
      history.replaceState(
        { view: state.currentView, detailId: state.detailTaskId, editId: state.editingTaskId },
        '',
      );
    }
  }, [state.currentView, state.detailTaskId, state.editingTaskId]);

  useEffect(() => {
    async function handlePopState(e: PopStateEvent) {
      const s = e.state as HistoryState | null;
      if (!s) return;
      dispatch({ type: 'SET_VIEW', view: normalizeView(s.view) });
      if (s.editId || s.detailId) {
        const tasks = await idbGetAllTasks();
        const taskMap = Object.fromEntries(tasks.map(t => [t.id, t]));
        if (s.editId && taskMap[s.editId]) {
          dispatch({ type: 'SET_EDITING', id: s.editId });
          dispatch({ type: 'SET_DETAIL', id: null });
        } else if (s.detailId && taskMap[s.detailId]) {
          dispatch({ type: 'SET_DETAIL', id: s.detailId });
          dispatch({ type: 'SET_EDITING', id: null });
        } else {
          dispatch({ type: 'SET_EDITING', id: null });
          dispatch({ type: 'SET_DETAIL', id: null });
        }
      } else {
        dispatch({ type: 'SET_EDITING', id: null });
        dispatch({ type: 'SET_DETAIL', id: null });
      }
    }

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [dispatch]);
}
