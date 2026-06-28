import * as v from 'valibot';
import type { Task, Project, TaskLink } from '../types';
import { TaskRowSchema, ProjectRowSchema, TaskLinkRowSchema, parseTaskRow } from '@shared/wire/rows';
import { parseSchema } from '@shared/parse';
import { apiRequest, type ApiConfig } from './client';
import type { ApiResult } from './result';

// PWA-local wire request body types (field names match the REST contract).
// Intentionally separate from shared/types aliases — stage 6 finalises the migration.
export interface TaskCreateBody {
  title: string;
  notes?: string | null;
  due_date?: string | null;
  recurrence?: string | null;
  task_type?: string;
  project_id?: string | null;
  kickoff_note?: string | null;
}

export type TaskUpdateBody = Partial<{
  title: string;
  notes: string | null;
  due_date: string | null;
  recurrence: string | null;
  task_type: string;
  project_id: string | null;
  kickoff_note: string | null;
  session_log: string | null;
  status: string;
  defer_until: string | null;
  defer_kind: string;
  focused_until: string | null;
}>;

export interface LinkBody {
  from_task_id: string;
  to_task_id: string;
  link_type: string;
}

// Worker confirmation shape for deletes and link writes.
const ConfirmationSchema = v.object({ ok: v.literal(true) });
type Confirmation = v.InferOutput<typeof ConfirmationSchema>;

// Worker complete-task response shape.
const CompleteResultSchema = v.object({
  completed: TaskRowSchema,
  next: v.optional(TaskRowSchema),
});

export interface CompleteResult {
  completed: Task;
  next?: Task | undefined;
}

function jsonBody(body: unknown): RequestInit {
  return { method: 'POST', body: JSON.stringify(body) };
}

export const api = {
  createTask(body: TaskCreateBody, config: ApiConfig): Promise<ApiResult<Task>> {
    return apiRequest('/api/tasks', jsonBody(body), config, parseTaskRow);
  },

  updateTask(id: string, body: TaskUpdateBody, config: ApiConfig): Promise<ApiResult<Task>> {
    return apiRequest(
      `/api/tasks/${id}`,
      { method: 'PATCH', body: JSON.stringify(body) },
      config,
      parseTaskRow,
    );
  },

  deleteTask(id: string, config: ApiConfig): Promise<ApiResult<Confirmation>> {
    return apiRequest(
      `/api/tasks/${id}`,
      { method: 'DELETE' },
      config,
      raw => parseSchema(ConfirmationSchema, raw),
    );
  },

  completeTask(id: string, config: ApiConfig): Promise<ApiResult<CompleteResult>> {
    return apiRequest(
      `/api/tasks/${id}/complete`,
      { method: 'POST' },
      config,
      raw => parseSchema(CompleteResultSchema, raw),
    );
  },

  syncTasks(config: ApiConfig): Promise<ApiResult<Task[]>> {
    return apiRequest(
      '/api/tasks/sync',
      {},
      config,
      raw => parseSchema(v.array(TaskRowSchema), raw),
    );
  },

  syncProjects(config: ApiConfig): Promise<ApiResult<Project[]>> {
    return apiRequest(
      '/api/projects/sync',
      {},
      config,
      raw => parseSchema(v.array(ProjectRowSchema), raw),
    );
  },

  listLinks(config: ApiConfig): Promise<ApiResult<TaskLink[]>> {
    return apiRequest(
      '/api/tasks/links',
      {},
      config,
      raw => parseSchema(v.array(TaskLinkRowSchema), raw),
    );
  },

  createLink(body: LinkBody, config: ApiConfig): Promise<ApiResult<Confirmation>> {
    return apiRequest(
      '/api/tasks/links',
      jsonBody(body),
      config,
      raw => parseSchema(ConfirmationSchema, raw),
    );
  },

  deleteLink(body: LinkBody, config: ApiConfig): Promise<ApiResult<Confirmation>> {
    return apiRequest(
      '/api/tasks/links',
      { method: 'DELETE', body: JSON.stringify(body) },
      config,
      raw => parseSchema(ConfirmationSchema, raw),
    );
  },
};
