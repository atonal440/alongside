export type { Task, Project, TaskLink, ActionLog } from './schema';

import type { Task, Project } from './schema';

export type TaskCreate = Pick<Task, 'title'> &
  Partial<Pick<Task, 'notes' | 'due_date' | 'recurrence' | 'task_type' | 'project_id' | 'kickoff_note'>>;

export type TaskUpdate = Partial<Pick<Task,
  'title' | 'notes' | 'due_date' | 'recurrence' | 'task_type' | 'project_id' |
  'kickoff_note' | 'session_log' | 'status' | 'defer_until' | 'defer_kind' | 'focused_until'>>;

export type ProjectCreate = Pick<Project, 'title'> & Partial<Pick<Project, 'kickoff_note' | 'notes'>>;
export type ProjectUpdate = Partial<Pick<Project, 'title' | 'kickoff_note' | 'notes' | 'status'>>;
