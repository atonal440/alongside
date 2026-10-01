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

// Prefixes are shared by client-minted IDs and server IDs. The reliable command
// layer decides minting/replay ownership; parsing never implies existence.
function entityIdSchema<const Name extends string>(prefix: string, _name: Name) {
  return v.pipe(v.string(), v.regex(new RegExp(`^${prefix}_[0-9A-Za-z_-]{5,64}$`)), v.transform(value => value as Brand<string, Name>));
}
export const DutyIdSchema = entityIdSchema('d', 'DutyId');
export const TimeBlockIdSchema = entityIdSchema('b', 'TimeBlockId');
export const ReminderIdSchema = entityIdSchema('r', 'ReminderId');
export const CommandIdSchema = entityIdSchema('c', 'CommandId');
export const TagIdSchema = entityIdSchema('tag', 'TagId');
export const EntryIdSchema = entityIdSchema('e', 'EntryId');
export const WorkLogIdSchema = entityIdSchema('w', 'WorkLogId');
export const SavedQueryIdSchema = entityIdSchema('q', 'SavedQueryId');
export type DutyId = v.InferOutput<typeof DutyIdSchema>;
export type TimeBlockId = v.InferOutput<typeof TimeBlockIdSchema>;
export type ReminderId = v.InferOutput<typeof ReminderIdSchema>;
export type CommandId = v.InferOutput<typeof CommandIdSchema>;
export type TagId = v.InferOutput<typeof TagIdSchema>;
export type EntryId = v.InferOutput<typeof EntryIdSchema>;
export type WorkLogId = v.InferOutput<typeof WorkLogIdSchema>;
export type SavedQueryId = v.InferOutput<typeof SavedQueryIdSchema>;
export const parseDutyId = (input: unknown) => parseSchema(DutyIdSchema, input);
export const parseTimeBlockId = (input: unknown) => parseSchema(TimeBlockIdSchema, input);
export const parseReminderId = (input: unknown) => parseSchema(ReminderIdSchema, input);
export const parseCommandId = (input: unknown) => parseSchema(CommandIdSchema, input);
export const parseTagId = (input: unknown) => parseSchema(TagIdSchema, input);
export const parseEntryId = (input: unknown) => parseSchema(EntryIdSchema, input);
export const parseWorkLogId = (input: unknown) => parseSchema(WorkLogIdSchema, input);
export const parseSavedQueryId = (input: unknown) => parseSchema(SavedQueryIdSchema, input);
