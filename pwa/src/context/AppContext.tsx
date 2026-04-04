import { createContext, useReducer, useEffect, type Dispatch, type ReactNode } from 'react';
import { reducer, getInitialState, type AppState, type AppAction } from './reducer';
import { idbGetAllTasks } from '../idb/tasks';
import { idbGetAllProjects } from '../idb/projects';
import { idbGetAllLinks } from '../idb/links';

interface AppContextValue {
  state: AppState;
  dispatch: Dispatch<AppAction>;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, undefined, getInitialState);

  // Load data from IDB on mount so the UI is populated before the first network sync
  useEffect(() => {
    Promise.all([idbGetAllTasks(), idbGetAllProjects(), idbGetAllLinks()])
      .then(([tasks, projects, links]) => {
        dispatch({ type: 'SET_DATA', tasks, projects, links });
      })
      .catch(err => console.warn('Initial IDB load failed:', err));
  }, []);

  return (
    <AppContext.Provider value={{ state, dispatch }}>
      {children}
    </AppContext.Provider>
  );
}
