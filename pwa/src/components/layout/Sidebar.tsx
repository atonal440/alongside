import { useAppState } from '../../hooks/useAppState';
import { pushNav } from '../../hooks/useHistory';
import { projectColor } from '../../utils/design';
import type { AppState } from '../../context/reducer';

const VIEWS: { id: AppState['currentView']; label: string }[] = [
  { id: 'suggest', label: 'Today' },
  { id: 'all', label: 'All Tasks' },
  { id: 'review', label: 'Review' },
];

export function Sidebar() {
  const { state, dispatch } = useAppState();
  const activeTasks = state.tasks.filter(t => t.status !== 'done');
  const readyCount = activeTasks.length;
  const projectCounts = new Map<string, number>();

  for (const task of activeTasks) {
    if (task.project_id) projectCounts.set(task.project_id, (projectCounts.get(task.project_id) ?? 0) + 1);
  }

  function navigate(view: AppState['currentView']) {
    dispatch({ type: 'SET_PROJECT_FILTER', id: null });
    dispatch({ type: 'SET_VIEW', view });
    pushNav({ view, detailId: null, editId: null });
  }

  function openProject(projectId: string) {
    dispatch({ type: 'SET_PROJECT_FILTER', id: projectId });
    dispatch({ type: 'SET_VIEW', view: 'all' });
    pushNav({ view: 'all', detailId: null, editId: null });
  }

  function footerText(): string {
    switch (state.syncStatus) {
      case 'offline': return 'Offline - changes saved locally';
      case 'syncing': return 'Syncing...';
      case 'online': return 'Synced';
      case 'idle': return 'Ready to sync';
    }
  }

  return (
    <aside className="sidebar" aria-label="Primary">
      <div className="sidebar-logo">Along<span>side</span></div>

      <div className="sidebar-section">
        <div className="sidebar-label">Work</div>
        {VIEWS.map(view => (
          <button
            key={view.id}
            className={`sidebar-item${state.currentView === view.id && !state.selectedProjectId ? ' active' : ''}`}
            onClick={() => navigate(view.id)}
          >
            <span className="sidebar-dot" style={{ background: view.id === 'suggest' ? 'var(--accent)' : 'var(--ink-3)' }} />
            <span>{view.label}</span>
            {view.id === 'suggest' && <span className="sidebar-count">{readyCount}</span>}
          </button>
        ))}
      </div>

      <div className="sidebar-section sidebar-projects">
        <div className="sidebar-label">Projects</div>
        {state.projects.length === 0 ? (
          <div className="sidebar-empty">No projects yet</div>
        ) : (
          state.projects.slice(0, 8).map(project => (
            <button
              key={project.id}
              className={`sidebar-item${state.selectedProjectId === project.id ? ' active' : ''}`}
              onClick={() => openProject(project.id)}
            >
              <span className="sidebar-dot" style={{ background: projectColor(project.id) }} />
              <span className="sidebar-title">{project.title}</span>
              <span className="sidebar-count">{projectCounts.get(project.id) ?? 0}</span>
            </button>
          ))
        )}
      </div>

      <div className={`sidebar-footer ${state.syncStatus}`}>
        <span className="session-dot" />
        <span>{footerText()}</span>
      </div>
    </aside>
  );
}

export function CompactNavigation() {
  const { state, dispatch } = useAppState();
  const readyCount = state.tasks.filter(t => t.status !== 'done').length;

  function navigate(view: AppState['currentView']) {
    dispatch({ type: 'SET_PROJECT_FILTER', id: null });
    dispatch({ type: 'SET_VIEW', view });
    pushNav({ view, detailId: null, editId: null });
  }

  return (
    <nav className="compact-nav" aria-label="Primary">
      <div className="compact-logo">Along<span>side</span></div>
      <div className="compact-nav-items">
        {VIEWS.map(view => (
          <button
            key={view.id}
            className={`compact-nav-item${state.currentView === view.id && !state.selectedProjectId ? ' active' : ''}`}
            onClick={() => navigate(view.id)}
          >
            <span className="sidebar-dot" style={{ background: view.id === 'suggest' ? 'var(--accent)' : 'var(--ink-3)' }} />
            <span>{view.label}</span>
            {view.id === 'suggest' && <span className="sidebar-count">{readyCount}</span>}
          </button>
        ))}
      </div>
    </nav>
  );
}
