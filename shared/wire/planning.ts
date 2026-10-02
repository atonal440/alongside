import * as v from 'valibot';
import { CLIENT_PROTOCOL, MIN_WRITE_PROTOCOL } from './clientVersion';
import { SyncResetSchema } from './syncCursor';
import { EntitySnapshotSchema, LinkSnapshotSchema } from './versions';
import { EventInstantSchema, LocalDateSchema, LocalTimeSchema, MinuteInstantSchema, PositiveMinutesSchema, RevisionSchema, TaskIdSchema, parseSchema } from '../parse';
import { TimezoneSchema } from '../parse/time';
import { RelativeOffsetSchema, TaskDateRoleSchema, TemporalPointSchema } from '../temporal';

export const CONTRACT_VERSION = 2;
export const DisambiguationSchema = v.picklist(['earlier', 'later', 'reject']);
export const WorkingHoursSchema = v.pipe(v.strictObject({
  weekday: v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(7)),
  start: LocalTimeSchema, end: LocalTimeSchema,
}), v.check(value => value.end > value.start, 'Split overnight working hours at midnight.'));
export const PlanningSettingsSchema = v.strictObject({
  timezone: TimezoneSchema,
  workingHours: v.pipe(v.array(WorkingHoursSchema), v.maxLength(28)),
  bufferMinutes: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(1_440)),
  revision: RevisionSchema,
});
export type PlanningSettings = v.InferOutput<typeof PlanningSettingsSchema>;
export const parsePlanningSettings = (input: unknown) => parseSchema(PlanningSettingsSchema, input);
export const CapabilitiesInputSchema = v.strictObject({ timezone: v.optional(TimezoneSchema) });
export const ResolveTimeInputSchema = v.variant('kind', [
  v.strictObject({ kind: v.literal('wall_time'), date: LocalDateSchema, time: LocalTimeSchema, timezone: v.optional(TimezoneSchema), disambiguation: v.optional(DisambiguationSchema) }),
  v.strictObject({ kind: v.literal('date_boundary'), date: LocalDateSchema, role: TaskDateRoleSchema, timezone: v.optional(TimezoneSchema) }),
  v.pipe(
    v.strictObject({ kind: v.literal('offset'), point: TemporalPointSchema, offset: RelativeOffsetSchema, dateAnchorTime: v.optional(LocalTimeSchema), disambiguation: v.optional(DisambiguationSchema) }),
    v.forward(v.check(input => (input.offset.kind === 'elapsed_minutes' && input.point.kind === 'date')
      ? input.dateAnchorTime !== undefined : input.dateAnchorTime === undefined,
    'dateAnchorTime is required only for elapsed offsets from a date and is forbidden otherwise.'), ['dateAnchorTime']),
  ),
]);
export type ResolveTimeInput = v.InferOutput<typeof ResolveTimeInputSchema>;
export const LegacyDatesPreviewInputSchema = v.strictObject({
  timezone: v.optional(TimezoneSchema),
  after: v.optional(TaskIdSchema),
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(500))),
});
export type LegacyDatesPreviewInput = v.InferOutput<typeof LegacyDatesPreviewInputSchema>;
export const TimezoneSourceSchema = v.picklist(['request', 'workspace', 'fallback_utc']);
export type TimezoneSource = v.InferOutput<typeof TimezoneSourceSchema>;
export const ContractErrorSchema = v.strictObject({
  code: v.string(), path: v.array(v.string()), message: v.string(), retryable: v.boolean(), recoveryHint: v.string(),
});
export const CapabilitiesSchema = v.strictObject({
  contractVersion: v.literal(2), serverNow: EventInstantSchema, timezone: TimezoneSchema,
  timezoneSource: TimezoneSourceSchema, setupRequired: v.boolean(),
  features: v.strictObject({ temporalResolution: v.literal(true), legacyDatePreview: v.literal(true), reliableCommands: v.literal(true), hierarchy: v.literal(false), taskDates: v.literal(false), timeblocks: v.literal(false), reminders: v.literal(false), seriesMaterialization: v.literal(false), deltaSync: v.literal(true) }),
  clientProtocol: v.strictObject({ current: v.literal(CLIENT_PROTOCOL), minimumWrite: v.literal(MIN_WRITE_PROTOCOL) }),
  limits: v.strictObject({ atomicStatements: v.literal(100), maxHierarchyDepth: v.literal(32), maxPreviewRows: v.literal(500), maxDurationMinutes: PositiveMinutesSchema }),
  delivery: v.strictObject({ inbox: v.literal('unavailable'), webPush: v.literal('unconfigured'), backgroundEnabled: v.literal(false) }),
  recurrencePolicy: v.strictObject({ gap: v.literal('skip'), fold: v.literal('earlier') }),
});
export type Capabilities = v.InferOutput<typeof CapabilitiesSchema>;
export const parseCapabilities = (input: unknown) => parseSchema(CapabilitiesSchema, input);
export const TimeResolutionSchema = v.strictObject({
  contractVersion: v.literal(2), serverNow: EventInstantSchema, timezone: TimezoneSchema, timezoneSource: TimezoneSourceSchema,
  at: MinuteInstantSchema, comparison: v.picklist(['inclusive', 'exclusive']),
});
export type TimeResolution = v.InferOutput<typeof TimeResolutionSchema>;
export const parseTimeResolution = (input: unknown) => parseSchema(TimeResolutionSchema, input);

const LegacyOriginalSchema = v.strictObject({ due_date: v.string(), due_all_day: v.nullable(v.boolean()) });
export const FoundationErrorSchema = v.strictObject({
  ...ContractErrorSchema.entries,
  retryable: v.boolean(),
  details: v.optional(v.array(v.strictObject({ code: v.string(), path: v.array(v.string()), message: v.string() }))),
  alternatives: v.optional(v.array(v.strictObject({ at: MinuteInstantSchema, date: LocalDateSchema, time: LocalTimeSchema }))),
  currentSettings: v.optional(v.nullable(PlanningSettingsSchema)),
  expectedRevision: v.optional(v.nullable(RevisionSchema)),
  currentEntity: v.optional(EntitySnapshotSchema),
  currentLink: v.optional(LinkSnapshotSchema),
  expectedStructuralRevision: v.optional(RevisionSchema),
  requiredStatements: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(Number.MAX_SAFE_INTEGER))),
  limit: v.optional(v.literal(100)),
  syncReset: v.optional(SyncResetSchema),
});
export const LegacyDatesPreviewSchema = v.strictObject({
  contractVersion: v.literal(2), serverNow: EventInstantSchema, timezone: TimezoneSchema, timezoneSource: TimezoneSourceSchema,
  dryRun: v.literal(true), consistentSnapshot: v.literal(false), nextCursor: v.nullable(TaskIdSchema),
  candidates: v.array(v.strictObject({ taskId: TaskIdSchema, role: v.literal('target'), point: TemporalPointSchema, provenance: v.picklist(['legacy_all_day', 'legacy_timed', 'legacy_ambiguous']), original: LegacyOriginalSchema })),
  unresolved: v.array(v.strictObject({ taskId: TaskIdSchema, original: v.strictObject({ id: TaskIdSchema, due_date: v.nullable(v.string()), due_all_day: v.nullable(v.boolean()) }), error: FoundationErrorSchema })),
});
export type LegacyDatesPreview = v.InferOutput<typeof LegacyDatesPreviewSchema>;
export const parseLegacyDatesPreview = (input: unknown) => parseSchema(LegacyDatesPreviewSchema, input);

export const FoundationErrorEnvelopeSchema = v.pipe(v.strictObject({ contractVersion: v.literal(2), error: FoundationErrorSchema }),
  v.check(value => (value.error.code === 'sync_reset_required') === (value.error.syncReset !== undefined), 'Sync reset errors require reset diagnostics.'));
export type FoundationErrorDetail = v.InferOutput<typeof FoundationErrorSchema>;
export const parseFoundationErrorEnvelope = (input: unknown) => parseSchema(FoundationErrorEnvelopeSchema, input);
