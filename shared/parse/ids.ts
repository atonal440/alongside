import * as v from 'valibot';
import type { Brand } from '../brand';
import type { Result } from '../result';
import { parseSchema, type ValidationError } from './primitives';

export type TaskId = Brand<string, 'TaskId'>;
export type ParsedTaskId = TaskId & Brand<string, 'ParsedTaskId'>;
export type MintedTaskId = TaskId & Brand<string, 'MintedTaskId'>;

export type ProjectId = Brand<string, 'ProjectId'>;
export type ParsedProjectId = ProjectId & Brand<string, 'ParsedProjectId'>;
export type MintedProjectId = ProjectId & Brand<string, 'MintedProjectId'>;

export type OAuthCode = Brand<string, 'OAuthCode'>;

export const TASK_ID_PATTERN = /^t_[0-9A-Za-z_-]{5,}$/;
export const PROJECT_ID_PATTERN = /^p_[0-9A-Za-z_-]{5,}$/;
export const OAUTH_CODE_PATTERN = /^[0-9A-Za-z_-]{32}$/;

export const TaskIdSchema = v.pipe(
  v.string(),
  v.regex(TASK_ID_PATTERN, 'Expected a task id like t_x7k2m.'),
  v.transform(value => value as ParsedTaskId),
);

export const ProjectIdSchema = v.pipe(
  v.string(),
  v.regex(PROJECT_ID_PATTERN, 'Expected a project id like p_x7k2m.'),
  v.transform(value => value as ParsedProjectId),
);

export const OAuthCodeSchema = v.pipe(
  v.string(),
  v.regex(OAUTH_CODE_PATTERN, 'Expected a 32-character OAuth code.'),
  v.transform(value => value as OAuthCode),
);

export function parseTaskId(input: unknown): Result<ParsedTaskId, ValidationError[]> {
  return parseSchema(TaskIdSchema, input);
}

export function parseProjectId(input: unknown): Result<ParsedProjectId, ValidationError[]> {
  return parseSchema(ProjectIdSchema, input);
}

export function parseOAuthCode(input: unknown): Result<OAuthCode, ValidationError[]> {
  return parseSchema(OAuthCodeSchema, input);
}
