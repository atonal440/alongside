import * as v from 'valibot';
import { CommandIdSchema, EventInstantSchema, RevisionSchema, parseSchema } from '../parse';
import { PlanningSettingsSchema } from './planning';

// Initial command family: one complete settings replacement. Task/graph batches
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
export const CommandEnvelopeSchema = v.strictObject({
  contractVersion: v.literal(2), commandId: CommandIdSchema,
  actor: v.picklist(['user', 'llm', 'import']),
  reason: v.optional(v.pipe(v.string(), v.maxLength(1_000))),
  commands: v.pipe(v.array(v.strictObject({
    kind: v.literal('planning.set'), expectedRevision: v.nullable(RevisionSchema), values: PlanningValuesSchema,
  })), v.length(1, 'This release accepts exactly one planning.set command per batch.')),
});
export type CommandEnvelope = v.InferOutput<typeof CommandEnvelopeSchema>;
export const parseCommandEnvelope = (input: unknown) => parseSchema(CommandEnvelopeSchema, input);
export const PayloadHashSchema = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
export const PlanningDiffSchema = v.strictObject({
  entity: v.literal('planning_settings'), id: v.literal('workspace'),
  before: v.nullable(PlanningSettingsSchema), after: PlanningSettingsSchema,
});
const resultEntries = {
  contractVersion: v.literal(2), commandId: CommandIdSchema, payloadHash: PayloadHashSchema,
  serverNow: EventInstantSchema, changes: v.pipe(v.array(PlanningDiffSchema), v.length(1)),
  warnings: v.pipe(v.array(v.string()), v.maxLength(0)),
  // No client references are needed for the singleton settings entity.
  refs: v.strictObject({}),
};
export const ChangesPreviewSchema = v.strictObject({ ...resultEntries,
  dryRun: v.literal(true), requiredStatements: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100)),
});
export const ChangesResultSchema = v.strictObject({ ...resultEntries, applied: v.literal(true) });
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
