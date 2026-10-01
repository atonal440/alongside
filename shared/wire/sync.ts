import * as v from 'valibot';
import { CommandIdSchema, DutyIdSchema, EventInstantSchema, IsoDateTimeSchema, LinkTypeSchema,
  MinuteInstantSchema, ProjectIdSchema, RevisionSchema, SeriesRruleSchema, TaskIdSchema,
  TaskTypeSchema, TimezoneSchema, ToolNameSchema, boundedStringSchema, parseSchema } from '../parse';
import { ProjectRowSchema, TaskLinkRowSchema, TaskRowSchema, taskRowEntries } from './rows';
import { PlanningSettingsSchema, WorkingHoursSchema } from './planning';
import { ChangeDiffSchema } from './commands';

export const SyncCursorSchema = v.strictObject({ epoch: RevisionSchema, sequence: RevisionSchema });
export type SyncCursor = v.InferOutput<typeof SyncCursorSchema>;
const positiveId = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const logKey = v.pipe(v.string(), v.regex(/^[1-9][0-9]*$/), v.check(value => Number.isSafeInteger(Number(value))));
const linkKey = v.pipe(v.string(), v.check(value => {
  try {
    const parsed = v.safeParse(v.tuple([TaskIdSchema, TaskIdSchema, LinkTypeSchema]), JSON.parse(value));
    return parsed.success && JSON.stringify(parsed.output) === value;
  } catch { return false; }
}, 'Expected a canonical link identity tuple.'));
export const PreferenceRowSchema = v.variant('key', [
  v.strictObject({ key: v.literal('sort_by'), value: v.picklist(['readiness', 'due', 'project']) }),
  v.strictObject({ key: v.literal('urgency_visibility'), value: v.picklist(['show', 'hide']) }),
  v.strictObject({ key: v.literal('kickoff_nudge'), value: v.picklist(['always', 'missing', 'never']) }),
  v.strictObject({ key: v.literal('session_log'), value: v.picklist(['ask_at_end', 'auto_generate', 'off']) }),
  v.strictObject({ key: v.literal('interruption_style'), value: v.picklist(['proactive', 'quiet']) }),
  v.strictObject({ key: v.literal('planning_prompt'), value: v.picklist(['auto', 'always', 'never']) }),
  v.strictObject({ key: v.literal('last_session_at'), value: IsoDateTimeSchema }),
]);
export const DutyRowSchema = v.strictObject({
  id: DutyIdSchema, title: taskRowEntries.title,
  notes: v.nullable(boundedStringSchema(10_000)), kickoff_note: v.nullable(boundedStringSchema(2_000)),
  task_type: TaskTypeSchema, project_id: v.nullable(ProjectIdSchema), rrule: SeriesRruleSchema,
  dtstart: MinuteInstantSchema, timezone: v.nullable(TimezoneSchema),
  status: v.picklist(['active', 'paused', 'ended']), catch_up: v.picklist(['next', 'all']),
  last_spawned_at: v.nullable(MinuteInstantSchema), next_occurrence_at: v.nullable(MinuteInstantSchema),
  created_at: IsoDateTimeSchema, updated_at: IsoDateTimeSchema,
});
export const SyncActionLogRowSchema = v.strictObject({
  id: positiveId, tool_name: ToolNameSchema, task_id: v.nullable(TaskIdSchema), duty_id: v.nullable(DutyIdSchema),
  title: boundedStringSchema(500), detail: v.nullable(boundedStringSchema(2_000)), created_at: IsoDateTimeSchema,
});
export const SyncAuditRowSchema = v.strictObject({
  command_id: CommandIdSchema, actor: v.picklist(['user', 'llm', 'import', 'system']), reason: v.nullable(v.string()),
  changes_json: v.pipe(v.string(), v.check(value => {
    try { return v.safeParse(v.array(ChangeDiffSchema), JSON.parse(value)).success; } catch { return false; }
  }, 'Expected a validated command change array.')), created_at: IsoDateTimeSchema,
});
export const SyncPlanningRowSchema = v.strictObject({
  id: v.literal(1), timezone: TimezoneSchema, buffer_minutes: PlanningSettingsSchema.entries.bufferMinutes,
  revision: RevisionSchema, created_at: IsoDateTimeSchema, updated_at: IsoDateTimeSchema,
  working_hours: v.pipe(v.array(v.strictObject({
    weekday: WorkingHoursSchema.entries.weekday,
    start_time: WorkingHoursSchema.entries.start,
    end_time: WorkingHoursSchema.entries.end,
  })), v.maxLength(28), v.check(hours => {
    const sorted = [...hours].sort((a, b) => a.weekday - b.weekday || a.start_time.localeCompare(b.start_time));
    return sorted.every((hour, i) => hour.end_time > hour.start_time && (i === 0 || hour.weekday !== sorted[i - 1]!.weekday || hour.start_time >= sorted[i - 1]!.end_time));
  }, 'Working hours must be non-overlapping daytime intervals.')),
});
const version = { revision: RevisionSchema, deletedAt: v.nullable(EventInstantSchema) };
export const SyncEntitySchema = v.pipe(v.variant('entity', [
  v.strictObject({ ...version, entity: v.literal('task'), key: TaskIdSchema, row: v.nullable(TaskRowSchema) }),
  v.strictObject({ ...version, entity: v.literal('project'), key: ProjectIdSchema, row: v.nullable(ProjectRowSchema) }),
  v.strictObject({ ...version, entity: v.literal('link'), key: linkKey, row: v.nullable(TaskLinkRowSchema) }),
  v.strictObject({ ...version, entity: v.literal('duty'), key: DutyIdSchema, row: v.nullable(DutyRowSchema) }),
  v.strictObject({ ...version, entity: v.literal('preference'), key: v.picklist(['sort_by', 'urgency_visibility', 'kickoff_nudge', 'session_log', 'interruption_style', 'planning_prompt', 'last_session_at']), row: v.nullable(PreferenceRowSchema) }),
  v.strictObject({ ...version, entity: v.literal('planning_settings'), key: v.literal('workspace'), row: v.nullable(SyncPlanningRowSchema) }),
  v.strictObject({ ...version, entity: v.literal('action_log'), key: logKey, row: v.nullable(SyncActionLogRowSchema) }),
  v.strictObject({ ...version, entity: v.literal('command_audit'), key: CommandIdSchema, row: v.nullable(SyncAuditRowSchema) }),
]), v.check(value => {
  if (value.row === null) return value.deletedAt !== null;
  if (value.deletedAt !== null) return false;
  switch (value.entity) {
    case 'task': case 'project': case 'duty': return value.row.id === value.key;
    case 'link': return JSON.stringify([value.row.from_task_id, value.row.to_task_id, value.row.link_type]) === value.key;
    case 'preference': return value.row.key === value.key;
    case 'action_log': return String(value.row.id) === value.key;
    case 'command_audit': return value.row.command_id === value.key;
    case 'planning_settings': return true;
  }
}, 'Sync row must match its retained identity and deletion state.'));
export type SyncEntity = v.InferOutput<typeof SyncEntitySchema>;
export const WorkspaceSnapshotSchema = v.pipe(v.strictObject({
  contractVersion: v.literal(2), cursor: SyncCursorSchema, structuralRevision: RevisionSchema,
  entities: v.array(SyncEntitySchema),
}), v.check(value => {
  const identities = new Set(value.entities.map(entity => `${entity.entity}:${entity.key}`));
  if (identities.size !== value.entities.length) return false;
  const live = new Set(value.entities.filter(entity => entity.row !== null).map(entity => `${entity.entity}:${entity.key}`));
  return value.entities.every(entity => {
    if (entity.row === null) return true;
    if (entity.entity === 'task') return (entity.row.project_id === null || live.has(`project:${entity.row.project_id}`))
      && (entity.row.duty_id === null || live.has(`duty:${entity.row.duty_id}`));
    if (entity.entity === 'duty') return entity.row.project_id === null || live.has(`project:${entity.row.project_id}`);
    if (entity.entity === 'link') return live.has(`task:${entity.row.from_task_id}`) && live.has(`task:${entity.row.to_task_id}`);
    // Historical logs deliberately retain references to deleted task/duty IDs.
    return true;
  });
}, 'Snapshot identities must be unique and live references must resolve.'));
export type WorkspaceSnapshot = v.InferOutput<typeof WorkspaceSnapshotSchema>;
export const parseWorkspaceSnapshot = (input: unknown) => parseSchema(WorkspaceSnapshotSchema, input);
