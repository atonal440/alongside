import * as v from 'valibot';
import { CommandIdSchema, EventInstantSchema, MinuteInstantSchema, DueDateTimeSchema, RruleSchema, RevisionSchema, ProjectIdSchema, TaskIdSchema, TaskTypeSchema, boundedStringSchema, nonEmptyStringSchema, parseSchema } from '../parse';
import { PlanningSettingsSchema } from './planning';
import { ProjectRowSchema, TaskRowSchema } from './rows';

// Single-command families remain independently deployable until graph batches
// and offline command storage join this protocol in subsequent Slice 2 steps.
export const PlanningValuesSchema = v.pipe(v.strictObject({
  timezone: PlanningSettingsSchema.entries.timezone,
  workingHours: PlanningSettingsSchema.entries.workingHours,
  bufferMinutes: PlanningSettingsSchema.entries.bufferMinutes,
}), v.forward(v.check(value => {
  const hours = [...value.workingHours].sort((a, b) => a.weekday - b.weekday || a.start.localeCompare(b.start));
  return hours.every((hour, index) => index === 0 || hour.weekday !== hours[index - 1]!.weekday || hour.start >= hours[index - 1]!.end);
}, 'Working-hour intervals on the same weekday must not overlap.'), ['workingHours']));
export type PlanningValues = v.InferOutput<typeof PlanningValuesSchema>;
export const ClientRefSchema = v.pipe(v.string(), v.regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/),
  v.check(value => !['constructor', 'prototype', '__proto__'].includes(value), 'Client reference uses a reserved object key.'));
export const ProjectCreateValuesSchema = v.strictObject({
  title: nonEmptyStringSchema(200), notes: v.nullable(boundedStringSchema(10_000)), kickoffNote: v.nullable(boundedStringSchema(2_000)),
});
export const TaskCreateValuesSchema = v.strictObject({
  ...ProjectCreateValuesSchema.entries, taskType: TaskTypeSchema,
  project: v.nullable(v.strictObject({ id: ProjectIdSchema, expectedRevision: RevisionSchema })),
});
export const PlanningCommandSchema = v.strictObject({
  kind: v.literal('planning.set'), expectedRevision: v.nullable(RevisionSchema), values: PlanningValuesSchema,
});
export const ProjectCreateCommandSchema = v.strictObject({
  kind: v.literal('project.create'), id: ProjectIdSchema, clientRef: v.optional(ClientRefSchema),
  expectedRevision: v.null(), expectedStructuralRevision: RevisionSchema, values: ProjectCreateValuesSchema,
});
export const TaskCreateCommandSchema = v.strictObject({
  kind: v.literal('task.create'), id: TaskIdSchema, clientRef: v.optional(ClientRefSchema),
  expectedRevision: v.null(), expectedStructuralRevision: RevisionSchema, values: TaskCreateValuesSchema,
});
export const ProjectContentCommandSchema = v.strictObject({
  kind: v.literal('project.content.set'), id: ProjectIdSchema, expectedRevision: RevisionSchema, values: ProjectCreateValuesSchema,
});
export const TaskContentCommandSchema = v.strictObject({
  kind: v.literal('task.content.set'), id: TaskIdSchema, expectedRevision: RevisionSchema,
  values: v.strictObject({ ...ProjectCreateValuesSchema.entries, sessionLog: v.nullable(boundedStringSchema(10_000)) }),
});
// These transitions still store in the legacy task row codec, whose supported
// UTC years start at 0100. Keep the accepted command range aligned until those
// columns migrate to the complete temporal contract.
export const TaskSchedulingInstantSchema = v.pipe(MinuteInstantSchema,
  v.check(value => Number(value.slice(0, 4)) >= 100, 'Task scheduling instants require normalized UTC years 0100–9999.'));
export const DeferValuesSchema = v.variant('kind', [
  v.strictObject({ kind: v.literal('none') }),
  v.strictObject({ kind: v.literal('someday') }),
  v.strictObject({ kind: v.literal('until'), until: TaskSchedulingInstantSchema }),
]);
export const TaskFocusCommandSchema = v.strictObject({
  kind: v.literal('task.focus.set'), id: TaskIdSchema, expectedRevision: RevisionSchema,
  focusedUntil: v.nullable(TaskSchedulingInstantSchema),
});
export const TaskDeferCommandSchema = v.strictObject({
  kind: v.literal('task.defer.set'), id: TaskIdSchema, expectedRevision: RevisionSchema, defer: DeferValuesSchema,
});
export const TaskReopenCommandSchema = v.strictObject({ kind: v.literal('task.reopen'), id: TaskIdSchema, expectedRevision: RevisionSchema });
export const ProjectArchiveCommandSchema = v.strictObject({ kind: v.literal('project.archive'), id: ProjectIdSchema, expectedRevision: RevisionSchema });
export const ProjectReopenCommandSchema = v.strictObject({ kind: v.literal('project.reopen'), id: ProjectIdSchema, expectedRevision: RevisionSchema });
export const TaskCompleteCommandSchema = v.strictObject({
  kind: v.literal('task.complete'), id: TaskIdSchema, expectedRevision: RevisionSchema,
  expectedStructuralRevision: RevisionSchema,
  successor: v.nullable(v.strictObject({ id: TaskIdSchema, clientRef: v.optional(ClientRefSchema) })),
});
export const TaskProjectCommandSchema = v.strictObject({
  kind: v.literal('task.project.set'), id: TaskIdSchema, expectedRevision: RevisionSchema,
  expectedStructuralRevision: RevisionSchema,
  project: v.nullable(v.strictObject({ id: ProjectIdSchema, expectedRevision: RevisionSchema })),
});
export const TaskTypeCommandSchema = v.strictObject({
  kind: v.literal('task.type.set'), id: TaskIdSchema, expectedRevision: RevisionSchema, taskType: TaskTypeSchema,
});
const LegacyDueInstantSchema = v.pipe(DueDateTimeSchema,
  v.check(value => Number(value.slice(0, 4)) >= 100, 'Legacy task dates require normalized UTC years 0100–9999.'));
export const LegacyScheduleValuesSchema = v.pipe(v.strictObject({
  dueDate: v.nullable(LegacyDueInstantSchema), dueAllDay: v.nullable(v.boolean()), recurrence: v.nullable(RruleSchema),
}), v.check(value => value.dueDate !== null || (value.dueAllDay === null && value.recurrence === null), 'Clearing dueDate requires dueAllDay and recurrence to be null.'),
v.check(value => value.recurrence === null || value.dueAllDay !== false, 'Legacy recurrence requires an all-day or legacy-ambiguous due date.'));
export const TaskLegacyScheduleCommandSchema = v.strictObject({
  kind: v.literal('task.legacy-schedule.set'), id: TaskIdSchema, expectedRevision: RevisionSchema, values: LegacyScheduleValuesSchema,
});
export const CommandEnvelopeSchema = v.strictObject({
  contractVersion: v.literal(2), commandId: CommandIdSchema,
  actor: v.picklist(['user', 'llm', 'import']),
  reason: v.optional(v.pipe(v.string(), v.maxLength(1_000))),
  commands: v.pipe(v.array(v.variant('kind', [PlanningCommandSchema, ProjectCreateCommandSchema, TaskCreateCommandSchema, ProjectContentCommandSchema, TaskContentCommandSchema, TaskFocusCommandSchema, TaskDeferCommandSchema, TaskReopenCommandSchema, ProjectArchiveCommandSchema, ProjectReopenCommandSchema, TaskCompleteCommandSchema, TaskProjectCommandSchema, TaskTypeCommandSchema, TaskLegacyScheduleCommandSchema])), v.length(1, 'This release accepts exactly one command per batch.')),
});
export type CommandEnvelope = v.InferOutput<typeof CommandEnvelopeSchema>;
export const parseCommandEnvelope = (input: unknown) => parseSchema(CommandEnvelopeSchema, input);
export const PayloadHashSchema = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
export const PlanningDiffSchema = v.strictObject({
  entity: v.literal('planning_settings'), id: v.literal('workspace'),
  before: v.nullable(PlanningSettingsSchema), after: PlanningSettingsSchema,
});
export const ProjectCreateDiffSchema = v.strictObject({
  entity: v.literal('project'), id: ProjectIdSchema, before: v.null(),
  after: v.strictObject({ revision: RevisionSchema, row: ProjectRowSchema }),
});
export const TaskCreateDiffSchema = v.strictObject({
  entity: v.literal('task'), id: TaskIdSchema, before: v.null(),
  after: v.strictObject({ revision: RevisionSchema, row: TaskRowSchema }),
});
export const ProjectChangeDiffSchema = v.strictObject({
  entity: v.literal('project'), id: ProjectIdSchema,
  before: v.nullable(v.strictObject({ revision: RevisionSchema, row: ProjectRowSchema })),
  after: v.strictObject({ revision: RevisionSchema, row: ProjectRowSchema }),
});
export const TaskChangeDiffSchema = v.strictObject({
  entity: v.literal('task'), id: TaskIdSchema,
  before: v.nullable(v.strictObject({ revision: RevisionSchema, row: TaskRowSchema })),
  after: v.strictObject({ revision: RevisionSchema, row: TaskRowSchema }),
});
export const ChangeDiffSchema = v.variant('entity', [PlanningDiffSchema, ProjectChangeDiffSchema, TaskChangeDiffSchema]);
function validDiffIdentity(value: { changes: v.InferOutput<typeof ChangeDiffSchema>[]; refs: Record<string, string> }): boolean {
  if (value.changes.length === 0) return false;
  const identities = new Set<string>();
  const createdIds = new Set<string>();
  for (const change of value.changes) {
    if (identities.has(`${change.entity}:${change.id}`)) return false;
    identities.add(`${change.entity}:${change.id}`);
    if (change.entity === 'planning_settings') return value.changes.length === 1 && Object.keys(value.refs).length === 0;
    if (change.id !== change.after.row.id) return false;
    if (change.before !== null) {
      if (change.id !== change.before.row.id || change.after.revision !== change.before.revision + 1) return false;
    } else {
      if (change.after.revision !== 1) return false;
      createdIds.add(change.id);
    }
  }
  if (value.changes.length === 2) {
    const [completed, successor] = value.changes;
    if (completed?.entity !== 'task' || successor?.entity !== 'task' || completed.before?.row.status !== 'pending'
      || completed.after.row.status !== 'done' || successor.before !== null || successor.after.row.status !== 'pending') return false;
  }
  return Object.keys(value.refs).length <= 1 && Object.values(value.refs).every(id => createdIds.has(id));
}
const RefsSchema = v.pipe(v.custom<Record<string, string>>(input => input !== null && typeof input === 'object' && !Array.isArray(input)
  && Object.entries(input).every(([key, value]) => /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key)
    && !['constructor', 'prototype', '__proto__'].includes(key) && typeof value === 'string'), 'Expected valid client reference keys and IDs.'),
v.record(ClientRefSchema, v.union([TaskIdSchema, ProjectIdSchema])));
const resultEntries = {
  contractVersion: v.literal(2), commandId: CommandIdSchema, payloadHash: PayloadHashSchema,
  serverNow: EventInstantSchema, changes: v.pipe(v.array(ChangeDiffSchema), v.minLength(1), v.maxLength(2)),
  warnings: v.pipe(v.array(v.string()), v.maxLength(0)),
  refs: RefsSchema,
};
export const ChangesPreviewSchema = v.pipe(v.strictObject({ ...resultEntries,
  dryRun: v.literal(true), requiredStatements: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100)),
}), v.check(value => validDiffIdentity(value), 'Diff identity, revision and reference map must agree.'));
export const ChangesResultSchema = v.pipe(v.strictObject({ ...resultEntries, applied: v.literal(true) }),
  v.check(value => validDiffIdentity(value), 'Diff identity, revision and reference map must agree.'));
export type ChangesResult = v.InferOutput<typeof ChangesResultSchema>;
export type ChangesPreview = v.InferOutput<typeof ChangesPreviewSchema>;
export const parseChangesResult = (input: unknown) => parseSchema(ChangesResultSchema, input);
export const parseChangesPreview = (input: unknown) => parseSchema(ChangesPreviewSchema, input);
export const PlanningSettingsResponseSchema = v.strictObject({ contractVersion: v.literal(2), settings: v.nullable(PlanningSettingsSchema) });
export const PlanningSettingsExportSchema = v.strictObject({
  contractVersion: v.literal(2), kind: v.literal('planning_settings'), exportedAt: EventInstantSchema,
  values: v.nullable(PlanningValuesSchema),
});
export type PlanningSettingsResponse = v.InferOutput<typeof PlanningSettingsResponseSchema>;
export type PlanningSettingsExport = v.InferOutput<typeof PlanningSettingsExportSchema>;
export const parsePlanningSettingsResponse = (input: unknown) => parseSchema(PlanningSettingsResponseSchema, input);
export const parsePlanningSettingsExport = (input: unknown) => parseSchema(PlanningSettingsExportSchema, input);
export const StoredReceiptSchema = v.strictObject({
  command_id: CommandIdSchema, payload_hash: PayloadHashSchema, result_json: v.string(), created_at: EventInstantSchema,
});
