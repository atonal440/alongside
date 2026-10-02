import * as v from 'valibot';
import { CommandIdSchema, DutyIdSchema, EventInstantSchema, IsoDateTimeSchema, LinkTypeSchema,
  MinuteInstantSchema, ProjectIdSchema, RevisionSchema, SeriesRruleSchema, TaskIdSchema,
  TaskTypeSchema, TimezoneSchema, ToolNameSchema, boundedStringSchema, parseSchema } from '../parse';
import { ProjectRowSchema, TaskLinkRowSchema, TaskRowSchema, taskRowEntries } from './rows';
import { PlanningSettingsSchema, WorkingHoursSchema } from './planning';
import { ChangeDiffSchema } from './commands';
import { SyncCursorSchema } from './syncCursor';
export { SyncCursorSchema, parseSyncCursor, type SyncCursor } from './syncCursor';
const positiveId = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const logKey = v.pipe(v.string(), v.regex(/^[1-9][0-9]*$/), v.check(value => Number.isSafeInteger(Number(value))));
const linkKey = v.pipe(v.string(), v.check(value => {
  try {
    const parsed = v.safeParse(v.tuple([TaskIdSchema, TaskIdSchema, LinkTypeSchema]), JSON.parse(value));
    return parsed.success && JSON.stringify(parsed.output) === value;
  } catch { return false; }
}, 'Expected a canonical link identity tuple.'));
export const PreferenceRowSchema = v.variant('key', [
  // These read codecs preserve values advertised by retired MCP writers. New
  // preference writes still use the current domain's stricter choices.
  v.strictObject({ key: v.literal('sort_by'), value: v.picklist(['readiness', 'due', 'project', 'urgency', 'manual']) }),
  v.strictObject({ key: v.literal('urgency_visibility'), value: v.picklist(['show', 'hide']) }),
  v.strictObject({ key: v.literal('kickoff_nudge'), value: v.picklist(['always', 'missing', 'never']) }),
  v.strictObject({ key: v.literal('session_log'), value: v.picklist(['ask_at_end', 'auto_generate', 'off', 'manual']) }),
  v.strictObject({ key: v.literal('interruption_style'), value: v.picklist(['proactive', 'quiet', 'minimal']) }),
  v.strictObject({ key: v.literal('planning_prompt'), value: v.picklist(['auto', 'always', 'never', 'manual']) }),
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
  id: positiveId, tool_name: v.union([ToolNameSchema, v.literal('snooze_task')]), task_id: v.nullable(TaskIdSchema), duty_id: v.nullable(DutyIdSchema),
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
/**
 * First live reference that does not resolve to a live entity, or null. Historical
 * logs and audit deliberately retain references to deleted task/duty IDs.
 */
export function findDanglingReference(entities: Iterable<SyncEntity>): string | null {
  const images = [...entities];
  const live = new Set(images.filter(image => image.row !== null).map(image => `${image.entity}:${image.key}`));
  const has = (entity: string, key: string | null) => key === null || live.has(`${entity}:${key}`);
  for (const image of images) {
    switch (image.entity) {
      case 'task':
        if (image.row === null) break;
        if (!has('project', image.row.project_id)) return `Task ${image.key} references missing project ${image.row.project_id}.`;
        if (!has('duty', image.row.duty_id)) return `Task ${image.key} references missing duty ${image.row.duty_id}.`;
        break;
      case 'duty':
        if (image.row !== null && !has('project', image.row.project_id)) return `Duty ${image.key} references missing project ${image.row.project_id}.`;
        break;
      case 'link':
        if (image.row !== null && (!has('task', image.row.from_task_id) || !has('task', image.row.to_task_id))) return `Link ${image.key} references a missing task.`;
        break;
      default:
        break;
    }
  }
  return null;
}
export const WorkspaceSnapshotSchema = v.pipe(v.strictObject({
  contractVersion: v.literal(2), cursor: SyncCursorSchema, structuralRevision: RevisionSchema,
  entities: v.array(SyncEntitySchema),
}), v.check(value => {
  const identities = new Set(value.entities.map(entity => `${entity.entity}:${entity.key}`));
  return identities.size === value.entities.length && findDanglingReference(value.entities) === null;
}, 'Snapshot identities must be unique and live references must resolve.'));
export type WorkspaceSnapshot = v.InferOutput<typeof WorkspaceSnapshotSchema>;
export const parseWorkspaceSnapshot = (input: unknown) => parseSchema(WorkspaceSnapshotSchema, input);

export const WorkspaceDeltaInputSchema = v.pipe(v.strictObject({
  cursor: SyncCursorSchema,
  watermark: v.optional(SyncCursorSchema),
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(500))),
}), v.check(value => value.watermark === undefined || (value.watermark.epoch === value.cursor.epoch && value.watermark.sequence >= value.cursor.sequence),
'Continuation watermark must have the cursor epoch and cannot precede it.'));
export type WorkspaceDeltaInput = v.InferOutput<typeof WorkspaceDeltaInputSchema>;
export const parseWorkspaceDeltaInput = (input: unknown) => parseSchema(WorkspaceDeltaInputSchema, input);
export const WorkspaceDeltaSchema = v.pipe(v.strictObject({
  contractVersion: v.literal(2), from: SyncCursorSchema, cursor: SyncCursorSchema,
  watermark: SyncCursorSchema, hasMore: v.boolean(),
  changes: v.pipe(v.array(v.strictObject({ sequence: RevisionSchema, entity: SyncEntitySchema })), v.maxLength(500)),
}), v.check(value => {
  if (value.from.epoch !== value.cursor.epoch || value.from.epoch !== value.watermark.epoch
    || value.from.sequence > value.cursor.sequence || value.cursor.sequence > value.watermark.sequence) return false;
  let previous = value.from.sequence;
  const versions = new Map<string, number>();
  for (const change of value.changes) {
    if (change.sequence <= previous || change.sequence > value.cursor.sequence) return false;
    previous = change.sequence;
    const key = `${change.entity.entity}:${change.entity.key}`;
    const revision = versions.get(key);
    if (revision !== undefined && change.entity.revision <= revision) return false;
    versions.set(key, change.entity.revision);
  }
  return value.hasMore ? value.changes.length > 0 && previous === value.cursor.sequence && value.cursor.sequence < value.watermark.sequence
    : value.cursor.sequence === value.watermark.sequence;
}, 'Delta sequences, revisions and continuation cursors must agree.'));
export type WorkspaceDelta = v.InferOutput<typeof WorkspaceDeltaSchema>;
export const parseWorkspaceDelta = (input: unknown) => parseSchema(WorkspaceDeltaSchema, input);
