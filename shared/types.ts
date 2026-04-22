export type { Task, Project, TaskLink, ActionLog } from './schema';

export interface PendingOp {
  id?: number;
  method: string;
  path: string;
  body: unknown;
  local_id: string | null;
  created_at: string;
}

import type { Task, Project } from './schema';

export type TaskCreate = Pick<Task, 'title'> &
  Partial<Pick<Task, 'notes' | 'due_date' | 'recurrence' | 'task_type' | 'project_id' | 'kickoff_note'>>;

export type TaskUpdate = Partial<Pick<Task,
  'title' | 'notes' | 'due_date' | 'recurrence' | 'task_type' | 'project_id' |
  'kickoff_note' | 'session_log' | 'status' | 'snoozed_until' | 'focused_until'>>;

export type ProjectCreate = Pick<Project, 'title'> & Partial<Pick<Project, 'kickoff_note' | 'notes'>>;
export type ProjectUpdate = Partial<Pick<Project, 'title' | 'kickoff_note' | 'notes' | 'status'>>;
