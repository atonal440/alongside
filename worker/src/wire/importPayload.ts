import * as v from 'valibot';
import type { InferOutput } from 'valibot';
import type { ActionLog, Project, Task, TaskLink } from '@shared/types';
import type { Result } from '@shared/result';
import { err, ok } from '@shared/result';
import {
  boundedStringSchema,
  IsoDateTimeSchema,
  IsoDateSchema,
  LinkTypeSchema,
  parseSchema,
  ProjectIdSchema,
  ProjectStatusSchema,
  positiveIntSchema,
  RruleSchema,
  DeferKindSchema,
  TaskIdSchema,
  TaskStatusSchema,
  TaskTypeSchema,
  ToolNameSchema,
  type NonEmptyString,
  type ValidationError,
} from '../parse';

const TASK_TITLE_MAX = 200;
const TASK_NOTES_MAX = 10_000;
const TASK_KICKOFF_MAX = 2_000;
const TASK_SESSION_LOG_MAX = 10_000;
const PROJECT_TITLE_MAX = 200;
const PROJECT_NOTES_MAX = 10_000;
const PROJECT_KICKOFF_MAX = 2_000;
const ACTION_TITLE_MAX = 500;
const ACTION_DETAIL_MAX = 2_000;

function prefixErrors(path: string, errors: ValidationError[]): ValidationError[] {
  return errors.map(error => ({ ...error, path: [path, ...error.path] }));
}

function importTitleSchema<const Max extends number>(max: Max) {
  return v.pipe(
    v.string(),
    v.check(value => value.trim().length > 0, 'Expected a non-empty string.'),
    v.check(value => value.trim().length <= max, `Expected at most ${max} characters.`),
    v.transform(value => value as NonEmptyString<Max>),
  );
}

export const ProjectRowSchema = v.pipe(
  v.object({
    id: ProjectIdSchema,
    title: importTitleSchema(PROJECT_TITLE_MAX),
    notes: v.nullable(boundedStringSchema(PROJECT_NOTES_MAX)),
    kickoff_note: v.nullable(boundedStringSchema(PROJECT_KICKOFF_MAX)),
    status: ProjectStatusSchema,
    created_at: IsoDateTimeSchema,
    updated_at: IsoDateTimeSchema,
  }),
  v.transform((row): Project => ({ ...row })),
);

export const TaskRowSchema = v.pipe(
  v.object({
    id: TaskIdSchema,
    title: importTitleSchema(TASK_TITLE_MAX),
    notes: v.nullable(boundedStringSchema(TASK_NOTES_MAX)),
    status: TaskStatusSchema,
    due_date: v.nullable(IsoDateSchema),
    recurrence: v.nullable(RruleSchema),
    created_at: IsoDateTimeSchema,
    updated_at: IsoDateTimeSchema,
    defer_until: v.optional(v.nullable(IsoDateTimeSchema), null),
    defer_kind: v.optional(DeferKindSchema),
    snoozed_until: v.optional(v.nullable(IsoDateTimeSchema), null),
    task_type: TaskTypeSchema,
    project_id: v.nullable(ProjectIdSchema),
    kickoff_note: v.nullable(boundedStringSchema(TASK_KICKOFF_MAX)),
    session_log: v.nullable(boundedStringSchema(TASK_SESSION_LOG_MAX)),
    focused_until: v.nullable(IsoDateTimeSchema),
  }),
  v.transform((row): Task => {
    const hasCurrentDeferFields = row.defer_kind !== undefined;
    const deferKind = hasCurrentDeferFields
      ? (row.defer_kind ?? 'none')
      : (row.snoozed_until ? 'until' : 'none');
    const deferUntil = hasCurrentDeferFields
      ? row.defer_until
      : row.snoozed_until;

    return {
      id: row.id,
      title: row.title,
      notes: row.notes,
      status: row.status,
      due_date: row.due_date,
      recurrence: row.recurrence,
      created_at: row.created_at,
      updated_at: row.updated_at,
      defer_until: deferUntil,
      defer_kind: deferKind,
      task_type: row.task_type,
      project_id: row.project_id,
      kickoff_note: row.kickoff_note,
      session_log: row.session_log,
      focused_until: row.focused_until,
    };
  }),
);

export const TaskLinkRowSchema = v.pipe(
  v.object({
    from_task_id: TaskIdSchema,
    to_task_id: TaskIdSchema,
    link_type: LinkTypeSchema,
  }),
  v.transform((row): TaskLink => ({ ...row })),
);

export const ActionLogRowSchema = v.pipe(
  v.object({
    id: positiveIntSchema(Number.MAX_SAFE_INTEGER),
    tool_name: ToolNameSchema,
    task_id: v.nullable(TaskIdSchema),
    title: boundedStringSchema(ACTION_TITLE_MAX),
    detail: v.nullable(boundedStringSchema(ACTION_DETAIL_MAX)),
    created_at: IsoDateTimeSchema,
  }),
  v.transform((row): ActionLog => ({ ...row })),
);

export const ImportV1Schema = v.object({
  version: v.literal(1),
  exported_at: IsoDateTimeSchema,
  projects: v.array(ProjectRowSchema),
  tasks: v.array(TaskRowSchema),
  links: v.array(TaskLinkRowSchema),
  preferences: v.record(v.string(), v.string()),
  action_log: v.optional(v.array(ActionLogRowSchema)),
});

export type ParsedImportPayload = InferOutput<typeof ImportV1Schema>;

export function parseImport(input: unknown): Result<ParsedImportPayload, ValidationError[]> {
  const parsed = parseSchema(ImportV1Schema, input);
  if (!parsed.ok) return err(prefixErrors('payload', parsed.error));
  return ok(parsed.value);
}
