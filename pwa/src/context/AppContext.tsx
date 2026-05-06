import { createContext, useReducer, useEffect, type Dispatch, type ReactNode } from 'react';
import { reducer, getInitialState, type AppState, type AppAction } from './reducer';
import { idbGetAllTasks } from '../idb/tasks';
import { idbGetAllProjects } from '../idb/projects';
import { idbGetAllLinks } from '../idb/links';
import { idbGetAllDuties } from '../idb/duties';

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
      dispatch({ type: 'SET_DATA', tasks: [], projects: [], links: [], duties: [] });
      return;
    }

    let cancelled = false;
    Promise.all([idbGetAllTasks(), idbGetAllProjects(), idbGetAllLinks(), idbGetAllDuties()])
      .then(([tasks, projects, links, duties]) => {
        if (cancelled) return;
        dispatch({ type: 'SET_DATA', tasks, projects, links, duties });
      })
      .catch(err => console.warn('Initial IDB load failed:', err));

    return () => {
      cancelled = true;
    };
  }, [state.apiBase, state.authToken]);

  return (
    <AppContext.Provider value={{ state, dispatch }}>
      {children}
    </AppContext.Provider>
  );
}
