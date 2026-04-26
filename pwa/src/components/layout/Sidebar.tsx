import { useAppState } from '../../hooks/useAppState';
import { pushNav } from '../../hooks/useHistory';
import { projectColor } from '../../utils/design';
import type { AppState } from '../../context/reducer';
import { idbClearLinks } from '../../idb/links';
import { idbClearPendingOps } from '../../idb/pendingOps';
import { idbClearProjects } from '../../idb/projects';
import { idbClearTasks } from '../../idb/tasks';

const VIEWS: { id: AppState['currentView']; label: string }[] = [
  { id: 'suggest', label: 'Today' },
  { id: 'all', label: 'All Tasks' },
  { id: 'review', label: 'Review' },
];

async function clearLocalAppData(): Promise<void> {
  await Promise.all([
    idbClearPendingOps(),
    idbClearLinks(),
    idbClearProjects(),
    idbClearTasks(),
  ]);
}

function clearCredentials() {
  localStorage.removeItem('alongside_api');
  localStorage.removeItem('alongside_token');
  localStorage.removeItem('alongside_session');
  localStorage.setItem('alongside_logged_out', 'true');
}

export function Sidebar() {
  const { state, dispatch } = useAppState();
  const activeTasks = state.tasks.filter(t => t.status !== 'done');
  const readyCount = activeTasks.length;
  const projectCounts = new Map<string, number>();
  const isConfigured = Boolean(state.apiBase && state.authToken);

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
    if (!isConfigured) return 'Logged out';

    switch (state.syncStatus) {
      case 'offline': return 'Worker unreachable - changes saved locally';
      case 'syncing': return 'Syncing...';
      case 'online': return 'Synced';
      case 'idle': return 'Ready to sync';
    }
  }

  async function handleLogout() {
    try {
      await clearLocalAppData();
    } catch {
      dispatch({ type: 'SET_TOAST', message: 'Could not clear local data. Log out was cancelled.' });
      return;
    }
    clearCredentials();
    dispatch({ type: 'LOG_OUT' });
    pushNav({ view: 'suggest', detailId: null, editId: null });
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

      <div className={`sidebar-footer ${isConfigured ? state.syncStatus : 'logged-out'}`}>
        <div className="sidebar-footer-status">
          <span className="session-dot" />
          <span>{footerText()}</span>
        </div>
        {isConfigured && (
          <button className="sidebar-logout" onClick={handleLogout}>
            Log out
          </button>
        )}
      </div>
    </aside>
  );
}

export function CompactNavigation() {
  const { state, dispatch } = useAppState();
  const readyCount = state.tasks.filter(t => t.status !== 'done').length;
  const isConfigured = Boolean(state.apiBase && state.authToken);

  function navigate(view: AppState['currentView']) {
    dispatch({ type: 'SET_PROJECT_FILTER', id: null });
    dispatch({ type: 'SET_VIEW', view });
    pushNav({ view, detailId: null, editId: null });
  }

  async function handleLogout() {
    try {
      await clearLocalAppData();
    } catch {
      dispatch({ type: 'SET_TOAST', message: 'Could not clear local data. Log out was cancelled.' });
      return;
    }
    clearCredentials();
    dispatch({ type: 'LOG_OUT' });
    pushNav({ view: 'suggest', detailId: null, editId: null });
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
        {isConfigured && (
          <button className="compact-nav-item compact-logout" onClick={handleLogout}>
            <span>Log out</span>
          </button>
        )}
      </div>
    </nav>
  );
}
