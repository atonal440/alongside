import type { Task, Project, TaskLink } from '@shared/types';

export function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't_test1',
    title: 'Test task',
    notes: null,
    status: 'pending',
    due_date: null,
    recurrence: null,
    created_at: '2026-06-09T10:00:00.000Z',
    updated_at: '2026-06-09T10:00:00.000Z',
    defer_until: null,
    defer_kind: 'none',
    task_type: 'action',
    project_id: null,
    kickoff_note: null,
    session_log: null,
    focused_until: null,
    ...overrides,
  };
}

export function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p_test1',
    title: 'Test project',
    notes: null,
    kickoff_note: null,
    status: 'active',
    created_at: '2026-06-09T10:00:00.000Z',
    updated_at: '2026-06-09T10:00:00.000Z',
    ...overrides,
  };
}

export function makeLink(overrides: Partial<TaskLink> = {}): TaskLink {
  return {
    from_task_id: 't_from1',
    to_task_id: 't_to001',
    link_type: 'blocks',
    ...overrides,
  };
}
