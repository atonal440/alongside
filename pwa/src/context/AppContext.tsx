import { createContext, useReducer, useEffect, type Dispatch, type ReactNode } from 'react';
import { reducer, getInitialState, type AppState, type AppAction } from './reducer';
import { loadView } from '../sync/view';

interface AppContextValue {
  state: AppState;
  dispatch: Dispatch<AppAction>;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, getInitialState);

  // Show the stored canonical workspace plus queued commands immediately, before any network.
  useEffect(() => {
    if (!state.apiBase || !state.authToken) {
      dispatch({ type: 'SET_DATA', tasks: [], projects: [], links: [] });
      return;
    }

    let cancelled = false;
    loadView(state.apiBase)
      .then(view => { if (!cancelled) dispatch({ type: 'SET_DATA', tasks: view.tasks, projects: view.projects, links: view.links }); })
      .catch(err => console.warn('Initial local load failed:', err));
    return () => { cancelled = true; };
  }, [state.apiBase, state.authToken]);

  return (
    <AppContext.Provider value={{ state, dispatch }}>
      {children}
    </AppContext.Provider>
  );
}
