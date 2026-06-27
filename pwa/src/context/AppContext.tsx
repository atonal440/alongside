import { createContext, useReducer, useEffect, type Dispatch, type ReactNode } from 'react';
import { reducer, getInitialState, type AppState, type AppAction } from './reducer';
import { idbGetAllTasks } from '../idb/tasks';
import { idbGetAllProjects } from '../idb/projects';
import { idbGetAllLinks } from '../idb/links';
import { onDecodeReport, type DecodeReport } from '../idb/decode';

interface AppContextValue {
  state: AppState;
  dispatch: Dispatch<AppAction>;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, getInitialState);

  // Load local data only while a worker config is available.
  useEffect(() => {
    if (!state.apiBase || !state.authToken) {
      dispatch({ type: 'SET_DATA', tasks: [], projects: [], links: [] });
      return;
    }

    let cancelled = false;
    let totalQuarantined = 0;

    onDecodeReport((report: DecodeReport) => {
      totalQuarantined += report.quarantined.length;
    });

    Promise.all([idbGetAllTasks(), idbGetAllProjects(), idbGetAllLinks()])
      .then(([tasks, projects, links]) => {
        if (cancelled) return;
        if (totalQuarantined > 0) {
          console.error('[idb:decode] boot report', { totalQuarantined });
          const n = totalQuarantined;
          dispatch({
            type: 'SET_TOAST',
            message: `${n} item${n > 1 ? 's' : ''} couldn't be loaded; they're preserved and may recover after an update.`,
          });
        }
        dispatch({ type: 'SET_DATA', tasks, projects, links });
      })
      .catch(err => console.warn('Initial IDB load failed:', err));

    return () => {
      cancelled = true;
      onDecodeReport(() => {});
    };
  }, [state.apiBase, state.authToken]);

  return (
    <AppContext.Provider value={{ state, dispatch }}>
      {children}
    </AppContext.Provider>
  );
}
