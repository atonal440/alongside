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

describe('UPSERT_TASK', () => {
  test('inserts task into empty list', () => {
    const task = makeTask({ id: 't_1' });
    const state = reducer(baseState(), { type: 'UPSERT_TASK', task });
    expect(state.tasks).toHaveLength(1);
    expect(state.tasks[0]).toEqual(task);
  });

  test('replaces existing task by id', () => {
    const original = makeTask({ id: 't_1', title: 'Original' });
    const updated = makeTask({ id: 't_1', title: 'Updated' });
    const s1 = reducer(baseState(), { type: 'UPSERT_TASK', task: original });
    const s2 = reducer(s1, { type: 'UPSERT_TASK', task: updated });
    expect(s2.tasks).toHaveLength(1);
    expect(s2.tasks[0]?.title).toBe('Updated');
  });

  test('appends task with new id', () => {
    const a = makeTask({ id: 't_1' });
    const b = makeTask({ id: 't_2' });
    const s1 = reducer(baseState(), { type: 'UPSERT_TASK', task: a });
    const s2 = reducer(s1, { type: 'UPSERT_TASK', task: b });
    expect(s2.tasks).toHaveLength(2);
  });
});

describe('DELETE_TASK', () => {
  test('removes task by id', () => {
    const task = makeTask({ id: 't_1' });
    const s1 = reducer(baseState(), { type: 'UPSERT_TASK', task });
    const s2 = reducer(s1, { type: 'DELETE_TASK', id: 't_1' });
    expect(s2.tasks).toHaveLength(0);
  });

  test('does nothing when id not found', () => {
    const task = makeTask({ id: 't_1' });
    const s1 = reducer(baseState(), { type: 'UPSERT_TASK', task });
    const s2 = reducer(s1, { type: 'DELETE_TASK', id: 't_nope' });
    expect(s2.tasks).toHaveLength(1);
  });
});

describe('UPSERT_LINK', () => {
  test('inserts link', () => {
    const link = makeLink({ from_task_id: 't_a', to_task_id: 't_b', link_type: 'blocks' });
    const state = reducer(baseState(), { type: 'UPSERT_LINK', link });
    expect(state.links).toHaveLength(1);
  });

  test('deduplicates on (from, to, type) triple', () => {
    const link = makeLink({ from_task_id: 't_a', to_task_id: 't_b', link_type: 'blocks' });
    const s1 = reducer(baseState(), { type: 'UPSERT_LINK', link });
    const s2 = reducer(s1, { type: 'UPSERT_LINK', link });
    expect(s2.links).toHaveLength(1);
  });

  test('different type is a different link', () => {
    const blocks = makeLink({ from_task_id: 't_a', to_task_id: 't_b', link_type: 'blocks' });
    const related = makeLink({ from_task_id: 't_a', to_task_id: 't_b', link_type: 'related' });
    const s1 = reducer(baseState(), { type: 'UPSERT_LINK', link: blocks });
    const s2 = reducer(s1, { type: 'UPSERT_LINK', link: related });
    expect(s2.links).toHaveLength(2);
  });
});

describe('DELETE_LINK', () => {
  test('removes the exact (from, to, type) triple', () => {
    const link = makeLink({ from_task_id: 't_a', to_task_id: 't_b', link_type: 'blocks' });
    const s1 = reducer(baseState(), { type: 'UPSERT_LINK', link });
    const s2 = reducer(s1, { type: 'DELETE_LINK', from: 't_a', to: 't_b', linkType: 'blocks' });
    expect(s2.links).toHaveLength(0);
  });

  test('does not remove link with different type', () => {
    const link = makeLink({ from_task_id: 't_a', to_task_id: 't_b', link_type: 'blocks' });
    const s1 = reducer(baseState(), { type: 'UPSERT_LINK', link });
    const s2 = reducer(s1, { type: 'DELETE_LINK', from: 't_a', to: 't_b', linkType: 'related' });
    expect(s2.links).toHaveLength(1);
  });
});

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
