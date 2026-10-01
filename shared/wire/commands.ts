import * as v from 'valibot';
import { CommandIdSchema, EventInstantSchema, RevisionSchema, ProjectIdSchema, TaskIdSchema, TaskTypeSchema, boundedStringSchema, nonEmptyStringSchema, parseSchema } from '../parse';
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
export const CommandEnvelopeSchema = v.strictObject({
  contractVersion: v.literal(2), commandId: CommandIdSchema,
  actor: v.picklist(['user', 'llm', 'import']),
  reason: v.optional(v.pipe(v.string(), v.maxLength(1_000))),
  commands: v.pipe(v.array(v.variant('kind', [PlanningCommandSchema, ProjectCreateCommandSchema, TaskCreateCommandSchema])), v.length(1, 'This release accepts exactly one command per batch.')),
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
export const ChangeDiffSchema = v.variant('entity', [PlanningDiffSchema, ProjectCreateDiffSchema, TaskCreateDiffSchema]);
function validDiffIdentity(value: { changes: v.InferOutput<typeof ChangeDiffSchema>[]; refs: Record<string, string> }): boolean {
  const change = value.changes[0];
  if (!change) return false;
  if (change.entity === 'planning_settings') return Object.keys(value.refs).length === 0;
  return change.id === change.after.row.id && change.after.revision === 1 && Object.keys(value.refs).length <= 1
    && Object.values(value.refs).every(id => id === change.id);
}
const RefsSchema = v.pipe(v.custom<Record<string, string>>(input => input !== null && typeof input === 'object' && !Array.isArray(input)
  && Object.entries(input).every(([key, value]) => /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key)
    && !['constructor', 'prototype', '__proto__'].includes(key) && typeof value === 'string'), 'Expected valid client reference keys and IDs.'),
v.record(ClientRefSchema, v.union([TaskIdSchema, ProjectIdSchema])));
const resultEntries = {
  contractVersion: v.literal(2), commandId: CommandIdSchema, payloadHash: PayloadHashSchema,
  serverNow: EventInstantSchema, changes: v.pipe(v.array(ChangeDiffSchema), v.length(1)),
  warnings: v.pipe(v.array(v.string()), v.maxLength(0)),
  refs: RefsSchema,
};
export const ChangesPreviewSchema = v.pipe(v.strictObject({ ...resultEntries,
  dryRun: v.literal(true), requiredStatements: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100)),
}), v.check(value => validDiffIdentity(value), 'Creation diff identity, revision and reference map must agree.'));
export const ChangesResultSchema = v.pipe(v.strictObject({ ...resultEntries, applied: v.literal(true) }),
  v.check(value => validDiffIdentity(value), 'Creation diff identity, revision and reference map must agree.'));
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
