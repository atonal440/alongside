import * as v from 'valibot';
import type { InferOutput } from 'valibot';
import type { ActionLog, Task } from '@shared/types';
import type { Result } from '@shared/result';
import { err, ok } from '@shared/result';
import {
  IsoDateTimeSchema,
  parseSchema,
  positiveIntSchema,
  DeferKindSchema,
  TaskIdSchema,
  ToolNameSchema,
  boundedStringSchema,
  type ValidationError,
} from '../parse';
import {
  ProjectRowSchema,
  TaskLinkRowSchema,
  taskRowEntries,
} from '@shared/wire/rows';

export { ProjectRowSchema, TaskLinkRowSchema };

const ACTION_TITLE_MAX = 500;
const ACTION_DETAIL_MAX = 2_000;

function prefixErrors(path: string, errors: ValidationError[]): ValidationError[] {
  return errors.map(error => ({ ...error, path: [path, ...error.path] }));
}

// Import-only task schema: tolerates pre-006 legacy snoozed_until rows and
// normalizes them into the current defer_kind / defer_until shape.
const ImportTaskRowSchema = v.pipe(
  v.object({
    ...taskRowEntries,
    defer_until: v.optional(v.nullable(IsoDateTimeSchema), null),
    defer_kind: v.optional(DeferKindSchema),
    snoozed_until: v.optional(v.nullable(IsoDateTimeSchema), null),
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
  tasks: v.array(ImportTaskRowSchema),
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
