import { useReducer, type ReactNode } from 'react';
import { render } from '@testing-library/react';
import { AppContext } from '../../src/context/AppContext';
import { reducer, type AppState, type AppAction } from '../../src/context/reducer';

const DEFAULT_STATE: AppState = {
  tasks: [],
  projects: [],
  links: [],
  currentView: 'suggest',
  selectedProjectId: null,
  editingTaskId: null,
  detailTaskId: null,
  statusFilter: 'ready',
  showDone: false,
  syncStatus: 'idle',
  toastMessage: null,
  apiBase: 'http://test.example',
  authToken: 'test-token',
};

export function renderWithState(
  ui: ReactNode,
  initialState: Partial<AppState> = {},
) {
  const state: AppState = { ...DEFAULT_STATE, ...initialState };

  function Wrapper({ children }: { children: ReactNode }) {
    const [s, dispatch] = useReducer(reducer, state);
    const wrappedDispatch = (action: AppAction) => dispatch(action);
    return (
      <AppContext.Provider value={{ state: s, dispatch: wrappedDispatch }}>
        {children}
      </AppContext.Provider>
    );
  }

  return render(ui, { wrapper: Wrapper });
}
