export interface Task {
  id: string;
  title: string;
  notes: string | null;
  status: 'pending' | 'active' | 'done' | 'snoozed';
  due_date: string | null;
  recurrence: string | null;
  created_at: string;
  updated_at: string;
  snoozed_until: string | null;
  task_type: 'action' | 'plan';
  project_id: string | null;
  kickoff_note: string | null;
  session_log: string | null;
}

export interface Project {
  id: string;
  title: string;
  notes: string | null;
  kickoff_note: string | null;
  status: 'active' | 'archived';
  created_at: string;
  updated_at: string;
}

export interface TaskLink {
  from_task_id: string;
  to_task_id: string;
  link_type: 'blocks' | 'related';
}

export interface PendingOp {
  id?: number;
  method: string;
  path: string;
  body: unknown;
  local_id: string | null;
  created_at: string;
}

export type TaskCreate = Pick<Task, 'title'> &
  Partial<Pick<Task, 'notes' | 'due_date' | 'recurrence' | 'task_type' | 'project_id' | 'kickoff_note'>>;

export type TaskUpdate = Partial<Pick<Task,
  'title' | 'notes' | 'due_date' | 'recurrence' | 'task_type' | 'project_id' |
  'kickoff_note' | 'session_log' | 'status' | 'snoozed_until'>>;

export type ProjectCreate = Pick<Project, 'title'> & Partial<Pick<Project, 'kickoff_note' | 'notes'>>;
export type ProjectUpdate = Partial<Pick<Project, 'title' | 'kickoff_note' | 'notes' | 'status'>>;
