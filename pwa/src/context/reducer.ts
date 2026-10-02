import type { Task, Project, TaskLink } from '../types';

export type StatusFilter = 'ready' | 'deferred' | 'someday' | 'done';

export interface AppState {
  tasks: Task[];
  projects: Project[];
  links: TaskLink[];
  currentView: 'suggest' | 'all' | 'review';
  selectedProjectId: string | null;
  editingTaskId: string | null;
  detailTaskId: string | null;
  statusFilter: StatusFilter;
  showDone: boolean;
  syncStatus: 'idle' | 'syncing' | 'online' | 'offline';
  toastMessage: string | null;
  apiBase: string;
  authToken: string;
}

export type AppAction =
  | { type: 'SET_DATA'; tasks: Task[]; projects: Project[]; links: TaskLink[] }
  | { type: 'SET_VIEW'; view: AppState['currentView'] | 'session' }
  | { type: 'SET_PROJECT_FILTER'; id: string | null }
  | { type: 'SET_EDITING'; id: string | null }
  | { type: 'SET_DETAIL'; id: string | null }
  | { type: 'SET_STATUS_FILTER'; filter: StatusFilter }
  | { type: 'SET_SHOW_DONE'; value: boolean }
  | { type: 'SET_SYNC_STATUS'; status: AppState['syncStatus'] }
  | { type: 'SET_TOAST'; message: string | null }
  | { type: 'SET_CONFIG'; apiBase: string; authToken: string }
  | { type: 'LOG_OUT' };

const LOGGED_OUT_KEY = 'alongside_logged_out';

function getDefaultApiBase(): string {
  if (typeof window !== 'undefined' && window.location.hostname === 'localhost') {
    return 'http://localhost:8787';
  }
  return '';
}

export function getInitialState(): AppState {
  const loggedOut = localStorage.getItem(LOGGED_OUT_KEY) === 'true';
  const apiBase = loggedOut ? '' : (localStorage.getItem('alongside_api') ?? getDefaultApiBase());
  const authToken = loggedOut ? '' : (localStorage.getItem('alongside_token') || 'dev-token-change-me');
  return {
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
    apiBase,
    authToken,
  };
}

export function reducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'SET_DATA':
      return { ...state, tasks: action.tasks, projects: action.projects, links: action.links };

    case 'SET_VIEW':
      return { ...state, currentView: action.view === 'session' ? 'review' : action.view, editingTaskId: null, detailTaskId: null };

    case 'SET_PROJECT_FILTER':
      return { ...state, selectedProjectId: action.id, detailTaskId: null };

    case 'SET_EDITING':
      return { ...state, editingTaskId: action.id };

    case 'SET_DETAIL':
      return { ...state, detailTaskId: action.id };

    case 'SET_STATUS_FILTER':
      return { ...state, statusFilter: action.filter };

    case 'SET_SHOW_DONE':
      return { ...state, showDone: action.value };

    case 'SET_SYNC_STATUS':
      return { ...state, syncStatus: action.status };

    case 'SET_TOAST':
      return { ...state, toastMessage: action.message };

    case 'SET_CONFIG':
      return { ...state, apiBase: action.apiBase, authToken: action.authToken };

    case 'LOG_OUT':
      return {
        ...state,
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
        toastMessage: 'Logged out',
        apiBase: '',
        authToken: '',
      };
  }
}
