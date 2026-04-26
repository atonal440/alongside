import { useAppState } from '../../hooks/useAppState';
import { pushNav } from '../../hooks/useHistory';
import type { AppState } from '../../context/reducer';

const VIEWS: { id: AppState['currentView']; label: string }[] = [
  { id: 'suggest', label: 'Suggest' },
  { id: 'all', label: 'All' },
  { id: 'review', label: 'Review' },
];

export function NavBar() {
  const { state, dispatch } = useAppState();

  function navigate(view: AppState['currentView']) {
    dispatch({ type: 'SET_VIEW', view });
    pushNav({ view, detailId: null, editId: null });
  }

  return (
    <nav>
      {VIEWS.map(v => (
        <button
          key={v.id}
          className={state.currentView === v.id ? 'active' : ''}
          onClick={() => navigate(v.id)}
        >
          {v.label}
        </button>
      ))}
    </nav>
  );
}
