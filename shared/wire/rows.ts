import * as v from 'valibot';
import type { InferOutput } from 'valibot';
import type { Project, Task, TaskLink } from '../types';
import type { Result } from '../result';
import { TemporalPointTextSchema } from '../temporal';
import {
  boundedStringSchema,
  DeferKindSchema,
  DueDateTimeSchema,
  IsoDateTimeMinuteSchema,
  IsoDateTimeSchema,
  LinkTypeSchema,
  parseSchema,
  ProjectIdSchema,
  ProjectStatusSchema,
  RruleSchema,
  TaskIdSchema,
  TaskStatusSchema,
  TaskTypeSchema,
  type NonEmptyString,
  type ValidationError,
} from '../parse';

export const TASK_TITLE_MAX = 200;
export const TASK_NOTES_MAX = 10_000;
export const TASK_KICKOFF_MAX = 2_000;
export const TASK_SESSION_LOG_MAX = 10_000;
export const PROJECT_TITLE_MAX = 200;
export const PROJECT_NOTES_MAX = 10_000;
export const PROJECT_KICKOFF_MAX = 2_000;

// Validates non-empty bounded text without trimming; the title in a stored row
// is already clean — trimming would silently corrupt a round-trip.
function rowTitleSchema<const Max extends number>(max: Max) {
  return v.pipe(
    v.string(),
    v.check(value => value.trim().length > 0, 'Expected a non-empty string.'),
    v.check(value => value.trim().length <= max, `Expected at most ${max} characters.`),
    v.transform(value => value as NonEmptyString<Max>),
  );
}

// Canonical task row entries — current wire shape only (no legacy snoozed_until).
// The worker's import pipeline spreads these and overlays optional legacy fields.
//
// duty_id is a plain nullable string for now — the branded DutyId parser lands
// in Stage 3 (`docs/plans/duties/stage-3-duty-domain-and-ops.md`), which should
// tighten this to `v.nullable(DutyIdSchema)`. No duty ever sets it in Stage 1.
export const taskRowEntries = {
  id: TaskIdSchema,
  title: rowTitleSchema(TASK_TITLE_MAX),
  notes: v.nullable(boundedStringSchema(TASK_NOTES_MAX)),
  status: TaskStatusSchema,
  due_date: v.nullable(DueDateTimeSchema),
  // Null on legacy rows (predates this column); treated as all-day (true)
  // wherever read — see shared/schema.ts's due_all_day comment.
  due_all_day: v.nullable(v.boolean()),
  recurrence: v.nullable(RruleSchema),
  created_at: IsoDateTimeSchema,
  updated_at: IsoDateTimeSchema,
  defer_until: v.nullable(IsoDateTimeSchema),
  defer_kind: DeferKindSchema,
  task_type: TaskTypeSchema,
  project_id: v.nullable(ProjectIdSchema),
  kickoff_note: v.nullable(boundedStringSchema(TASK_KICKOFF_MAX)),
  session_log: v.nullable(boundedStringSchema(TASK_SESSION_LOG_MAX)),
  focused_until: v.nullable(IsoDateTimeSchema),
  duty_id: v.nullable(v.string()),
  occurrence_at: v.nullable(IsoDateTimeMinuteSchema),
  // Absent in images written before date roles existed; read as unset.
  available_from: v.optional(v.nullable(TemporalPointTextSchema), null),
  deadline: v.optional(v.nullable(TemporalPointTextSchema), null),
  // Hierarchy; absent in images written before it existed.
  parent_id: v.optional(v.nullable(TaskIdSchema), null),
  position: v.optional(v.nullable(v.pipe(v.number(), v.finite())), null),
};

export const TaskRowSchema = v.pipe(
  v.object(taskRowEntries),
  v.transform((row): Task => ({ ...row })),
);

export const projectRowEntries = {
  id: ProjectIdSchema,
  title: rowTitleSchema(PROJECT_TITLE_MAX),
  notes: v.nullable(boundedStringSchema(PROJECT_NOTES_MAX)),
  kickoff_note: v.nullable(boundedStringSchema(PROJECT_KICKOFF_MAX)),
  status: ProjectStatusSchema,
  created_at: IsoDateTimeSchema,
  updated_at: IsoDateTimeSchema,
};

export const ProjectRowSchema = v.pipe(
  v.object(projectRowEntries),
  v.transform((row): Project => ({ ...row })),
);

export const TaskLinkRowSchema = v.pipe(
  v.object({
    from_task_id: TaskIdSchema,
    to_task_id: TaskIdSchema,
    link_type: LinkTypeSchema,
  }),
  v.transform((row): TaskLink => ({ ...row })),
);

export type ParsedTaskRow = InferOutput<typeof TaskRowSchema>;
export type ParsedProjectRow = InferOutput<typeof ProjectRowSchema>;
export type ParsedTaskLinkRow = InferOutput<typeof TaskLinkRowSchema>;

// Compile-time proof that parsed output shapes are assignable to the canonical
// Drizzle row types. If assignability breaks, fix the schema — not the row type.
type Expect<T extends true> = T;
export type AssertTaskRowAssignable = Expect<ParsedTaskRow extends Task ? true : false>;
export type AssertProjectRowAssignable = Expect<ParsedProjectRow extends Project ? true : false>;
export type AssertTaskLinkRowAssignable = Expect<ParsedTaskLinkRow extends TaskLink ? true : false>;

export function parseTaskRow(input: unknown): Result<ParsedTaskRow, ValidationError[]> {
  return parseSchema(TaskRowSchema, input);
}

export function parseProjectRow(input: unknown): Result<ParsedProjectRow, ValidationError[]> {
  return parseSchema(ProjectRowSchema, input);
}

export function parseTaskLinkRow(input: unknown): Result<ParsedTaskLinkRow, ValidationError[]> {
  return parseSchema(TaskLinkRowSchema, input);
}
