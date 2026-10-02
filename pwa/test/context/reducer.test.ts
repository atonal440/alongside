import { describe, test, expect } from 'vitest';
import { reducer } from '../../src/context/reducer';
import type { AppState } from '../../src/context/reducer';
import { makeTask, makeLink, makeProject } from '../helpers/fixtures';

function baseState(): AppState {
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
    apiBase: 'http://localhost:8787',
    authToken: 'dev-token',
  };
}

describe('SET_VIEW', () => {
  test('"session" maps to "review"', () => {
    const state = reducer({ ...baseState(), currentView: 'suggest' }, { type: 'SET_VIEW', view: 'session' });
    expect(state.currentView).toBe('review');
  });

  test('standard view names pass through', () => {
    const state = reducer(baseState(), { type: 'SET_VIEW', view: 'all' });
    expect(state.currentView).toBe('all');
  });

  test('clears editingTaskId and detailTaskId', () => {
    const start = { ...baseState(), editingTaskId: 't_1', detailTaskId: 't_2' };
    const state = reducer(start, { type: 'SET_VIEW', view: 'suggest' });
    expect(state.editingTaskId).toBeNull();
    expect(state.detailTaskId).toBeNull();
  });
});

describe('LOG_OUT', () => {
  test('clears tasks, projects, links', () => {
    const start = {
      ...baseState(),
      tasks: [makeTask()],
      projects: [makeProject()],
      links: [makeLink()],
    };
    const state = reducer(start, { type: 'LOG_OUT' });
    expect(state.tasks).toHaveLength(0);
    expect(state.projects).toHaveLength(0);
    expect(state.links).toHaveLength(0);
  });

  test('clears apiBase and authToken', () => {
    const state = reducer(baseState(), { type: 'LOG_OUT' });
    expect(state.apiBase).toBe('');
    expect(state.authToken).toBe('');
  });

  test('sets toastMessage to "Logged out"', () => {
    const state = reducer(baseState(), { type: 'LOG_OUT' });
    expect(state.toastMessage).toBe('Logged out');
  });

  test('resets view to suggest', () => {
    const start = { ...baseState(), currentView: 'all' as const };
    const state = reducer(start, { type: 'LOG_OUT' });
    expect(state.currentView).toBe('suggest');
  });
});
