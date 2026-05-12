export type { Task, Project, TaskLink, ActionLog, Duty } from './schema';

export interface PendingOp {
  id?: number;
  method: string;
  path: string;
  body: unknown;
  local_id: string | null;
  created_at: string;
}

import type { Task, Project, Duty } from './schema';

export type TaskCreate = Pick<Task, 'title'> &
  Partial<Pick<Task, 'notes' | 'due_date' | 'recurrence' | 'task_type' | 'project_id' | 'kickoff_note'>>;

export type DutyTaskCreate = TaskCreate & Pick<Task, 'duty_id' | 'duty_fire_at'>;

export type TaskUpdate = Partial<Pick<Task,
  'title' | 'notes' | 'due_date' | 'recurrence' | 'task_type' | 'project_id' |
  'kickoff_note' | 'session_log' | 'status' | 'defer_until' | 'defer_kind' | 'focused_until'>>;

export type ProjectCreate = Pick<Project, 'title'> & Partial<Pick<Project, 'kickoff_note' | 'notes'>>;
export type ProjectUpdate = Partial<Pick<Project, 'title' | 'kickoff_note' | 'notes' | 'status'>>;

export type DutyCreate = Pick<Duty, 'title' | 'recurrence'> &
  Partial<Pick<Duty, 'notes' | 'kickoff_note' | 'task_type' | 'project_id' | 'due_offset_days' | 'active' | 'next_fire_at'>> &
  { first_fire_date?: string };

export type DutyUpdate = Partial<Pick<Duty,
  'title' | 'notes' | 'kickoff_note' | 'task_type' | 'project_id' | 'recurrence' |
  'due_offset_days' | 'active' | 'next_fire_at'>>;
