import * as v from 'valibot';
import type { Brand } from '../brand';
import type { Result } from '../result';
import { parseSchema, type ValidationError } from './primitives';

export const TASK_STATUSES = ['pending', 'done'] as const;
export const TASK_TYPES = ['action', 'plan'] as const;
export const DEFER_KINDS = ['none', 'until', 'someday'] as const;
export const LINK_TYPES = ['blocks', 'related'] as const;
export const PROJECT_STATUSES = ['active', 'archived'] as const;

export const TOOL_NAMES = [
  'start_session',
  'show_tasks',
  'show_project',
  'list_projects',
  'list_tasks',
  'get_ready_tasks',
  'add_task',
  'complete_task',
  'defer_task',
  'update_task',
  'reopen_task',
  'focus_task',
  'delete_task',
  'create_project',
  'update_project',
  'delete_project',
  'get_project_context',
  'link_tasks',
  'unlink_tasks',
  'update_preference',
  'get_action_log',
] as const;

export const USER_PREFERENCE_KEYS = [
  'sort_by',
  'urgency_visibility',
  'kickoff_nudge',
  'session_log',
  'interruption_style',
  'planning_prompt',
] as const;

export const INTERNAL_PREFERENCE_KEYS = ['last_session_at'] as const;
export const PREFERENCE_KEYS = [...USER_PREFERENCE_KEYS, ...INTERNAL_PREFERENCE_KEYS] as const;

export type PendingTaskStatus = Brand<'pending', 'TaskStatus'>;
export type DoneTaskStatus = Brand<'done', 'TaskStatus'>;
export type TaskStatus = PendingTaskStatus | DoneTaskStatus;
export type TaskType = Brand<(typeof TASK_TYPES)[number], 'TaskType'>;
export type DeferKind = Brand<(typeof DEFER_KINDS)[number], 'DeferKind'>;
export type LinkType = Brand<(typeof LINK_TYPES)[number], 'LinkType'>;
export type ProjectStatus = Brand<(typeof PROJECT_STATUSES)[number], 'ProjectStatus'>;
export type ToolName = Brand<(typeof TOOL_NAMES)[number], 'ToolName'>;
export type UserPreferenceKey = Brand<(typeof USER_PREFERENCE_KEYS)[number], 'UserPreferenceKey'>;
export type InternalPreferenceKey = Brand<(typeof INTERNAL_PREFERENCE_KEYS)[number], 'InternalPreferenceKey'>;
export type PreferenceKey = UserPreferenceKey | InternalPreferenceKey;

export const TaskStatusSchema = v.pipe(
  v.picklist(TASK_STATUSES),
  v.transform(value => value as TaskStatus),
);

export const PendingTaskStatusSchema = v.pipe(
  v.literal('pending'),
  v.transform(value => value as PendingTaskStatus),
);

export const DoneTaskStatusSchema = v.pipe(
  v.literal('done'),
  v.transform(value => value as DoneTaskStatus),
);

export const TaskTypeSchema = v.pipe(
  v.picklist(TASK_TYPES),
  v.transform(value => value as TaskType),
);

export const DeferKindSchema = v.pipe(
  v.picklist(DEFER_KINDS),
  v.transform(value => value as DeferKind),
);

export const LinkTypeSchema = v.pipe(
  v.picklist(LINK_TYPES),
  v.transform(value => value as LinkType),
);

export const ProjectStatusSchema = v.pipe(
  v.picklist(PROJECT_STATUSES),
  v.transform(value => value as ProjectStatus),
);

export const ToolNameSchema = v.pipe(
  v.picklist(TOOL_NAMES),
  v.transform(value => value as ToolName),
);

export const UserPreferenceKeySchema = v.pipe(
  v.picklist(USER_PREFERENCE_KEYS),
  v.transform(value => value as UserPreferenceKey),
);

export const InternalPreferenceKeySchema = v.pipe(
  v.picklist(INTERNAL_PREFERENCE_KEYS),
  v.transform(value => value as InternalPreferenceKey),
);

export const PreferenceKeySchema = v.pipe(
  v.picklist(PREFERENCE_KEYS),
  v.transform(value => value as PreferenceKey),
);

export function parseTaskStatus(input: unknown): Result<TaskStatus, ValidationError[]> {
  return parseSchema(TaskStatusSchema, input);
}

export function parseTaskType(input: unknown): Result<TaskType, ValidationError[]> {
  return parseSchema(TaskTypeSchema, input);
}

export function parseDeferKind(input: unknown): Result<DeferKind, ValidationError[]> {
  return parseSchema(DeferKindSchema, input);
}

export function parseLinkType(input: unknown): Result<LinkType, ValidationError[]> {
  return parseSchema(LinkTypeSchema, input);
}

export function parseProjectStatus(input: unknown): Result<ProjectStatus, ValidationError[]> {
  return parseSchema(ProjectStatusSchema, input);
}

export function parseToolName(input: unknown): Result<ToolName, ValidationError[]> {
  return parseSchema(ToolNameSchema, input);
}

export function parseUserPreferenceKey(input: unknown): Result<UserPreferenceKey, ValidationError[]> {
  return parseSchema(UserPreferenceKeySchema, input);
}

export function parsePreferenceKey(input: unknown): Result<PreferenceKey, ValidationError[]> {
  return parseSchema(PreferenceKeySchema, input);
}
