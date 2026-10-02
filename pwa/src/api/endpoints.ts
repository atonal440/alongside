import { parseFoundationErrorEnvelope, parseCapabilities, parseTimeResolution, parseLegacyDatesPreview, type Capabilities, type TimeResolution, type LegacyDatesPreview, type ResolveTimeInput, type LegacyDatesPreviewInput } from '@shared/wire/planning';
import { parseWorkspaceSnapshot, type WorkspaceSnapshot } from '@shared/wire/sync';
import { parseChangesPreview, parseChangesResult, parsePlanningSettingsExport, parsePlanningSettingsResponse, type ChangesPreview, type ChangesResult, type CommandEnvelope, type PlanningSettingsExport, type PlanningSettingsResponse } from '@shared/wire/commands';
import type { Timezone } from '@shared/parse';
import { parseEntityVersionResponse, parseEntitySnapshot, parseLinkSnapshot, type LinkKey, type LinkSnapshot, type EntityReadKey, type EntitySnapshot, type EntityKey, type EntityVersionResponse } from '@shared/wire/versions';
import * as v from 'valibot';
import type { Task, Project, TaskLink } from '../types';
import { TaskRowSchema, ProjectRowSchema, TaskLinkRowSchema, parseTaskRow } from '@shared/wire/rows';
import { parseSchema } from '@shared/parse';
import { apiRequest, type ApiConfig } from './client';
import type { ApiErrorBody, ApiResult } from './result';
import type { Result } from '@shared/result';
import type { ValidationError } from '@shared/parse';

// PWA-local wire request body types (field names match the REST contract).
// Intentionally separate from shared/types aliases — stage 6 finalises the migration.
export interface TaskCreateBody {
  title: string;
  notes?: string | null;
  due_date?: string | null;
  due_all_day?: boolean;
  recurrence?: string | null;
  task_type?: string;
  project_id?: string | null;
  kickoff_note?: string | null;
}

export type TaskUpdateBody = Partial<{
  title: string;
  notes: string | null;
  due_date: string | null;
  due_all_day: boolean;
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

const LegacyErrorSchema = v.object({
  error: v.string(),
  details: v.optional(v.array(v.object({ code: v.string(), path: v.array(v.string()), message: v.string() }))),
});
function parseFoundationError(raw: unknown): Result<ApiErrorBody, ValidationError[]> {
  // Auth/gateway errors may predate v2. Only unversioned string envelopes use
  // this validated fallback; declared v2 and all other JSON use the v2 parser.
  if (raw !== null && typeof raw === 'object' && !('contractVersion' in raw)
    && 'error' in raw && typeof raw.error === 'string') {
    const legacy = parseSchema(LegacyErrorSchema, raw);
    return legacy.ok ? { ok: true, value: { error: legacy.value.error, ...(legacy.value.details === undefined ? {} : { details: legacy.value.details }) } } : legacy;
  }
  const parsed = parseFoundationErrorEnvelope(raw);
  if (!parsed.ok) return parsed;
  return { ok: true, value: {
    error: parsed.value.error.message,
    contractError: parsed.value.error,
    ...(parsed.value.error.details === undefined ? {} : { details: parsed.value.error.details }),
  } };
}

export const api = {
  workspaceSnapshot(config: ApiConfig): Promise<ApiResult<WorkspaceSnapshot>> {
    return apiRequest('/api/v2/sync/snapshot', {}, config, parseWorkspaceSnapshot, parseFoundationError);
  },
  link(key: LinkKey, config: ApiConfig): Promise<ApiResult<LinkSnapshot>> {
    return apiRequest('/api/v2/link', jsonBody(key), config, parseLinkSnapshot, parseFoundationError);
  },
  entity(key: EntityReadKey, config: ApiConfig): Promise<ApiResult<EntitySnapshot>> {
    return apiRequest('/api/v2/entity', jsonBody(key), config, parseEntitySnapshot, parseFoundationError);
  },
  entityVersion(key: EntityKey, config: ApiConfig): Promise<ApiResult<EntityVersionResponse>> {
    return apiRequest('/api/v2/entity-version', jsonBody(key), config, parseEntityVersionResponse, parseFoundationError);
  },
  planningSettings(config: ApiConfig): Promise<ApiResult<PlanningSettingsResponse>> {
    return apiRequest('/api/v2/planning-settings', {}, config, parsePlanningSettingsResponse, parseFoundationError);
  },
  exportPlanningSettings(config: ApiConfig): Promise<ApiResult<PlanningSettingsExport>> {
    return apiRequest('/api/v2/planning-settings/export', {}, config, parsePlanningSettingsExport, parseFoundationError);
  },
  previewChanges(body: CommandEnvelope, config: ApiConfig): Promise<ApiResult<ChangesPreview>> {
    return apiRequest('/api/v2/changes/preview', jsonBody(body), config, parseChangesPreview, parseFoundationError);
  },
  applyChanges(body: CommandEnvelope, config: ApiConfig): Promise<ApiResult<ChangesResult>> {
    return apiRequest('/api/v2/changes', jsonBody(body), config, parseChangesResult, parseFoundationError);
  },
  capabilities(config: ApiConfig, timezone?: Timezone): Promise<ApiResult<Capabilities>> {
    const query = timezone === undefined ? '' : `?timezone=${encodeURIComponent(timezone)}`;
    return apiRequest(`/api/v2/capabilities${query}`, {}, config, parseCapabilities, parseFoundationError);
  },

  resolveTime(body: ResolveTimeInput, config: ApiConfig): Promise<ApiResult<TimeResolution>> {
    return apiRequest('/api/v2/resolve-time', jsonBody(body), config, parseTimeResolution, parseFoundationError);
  },

  previewLegacyDates(body: LegacyDatesPreviewInput, config: ApiConfig): Promise<ApiResult<LegacyDatesPreview>> {
    return apiRequest('/api/v2/legacy-dates/preview', jsonBody(body), config, parseLegacyDatesPreview, parseFoundationError);
  },

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
