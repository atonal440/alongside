import * as v from 'valibot';
import { PREFERENCE_KEYS, CommandIdSchema, EventInstantSchema, MinuteInstantSchema, DueDateTimeSchema, RruleSchema, RevisionSchema, ProjectIdSchema, TaskIdSchema, TaskTypeSchema, LinkTypeSchema, boundedStringSchema, nonEmptyStringSchema, parseSchema, parseIsoDate, parseRrule, nextOccurrence } from '../parse';
import { PlanningSettingsSchema } from './planning';
import { ProjectRowSchema, TaskRowSchema, TaskLinkRowSchema } from './rows';

// Standalone and bounded mixed families share replay receipts. Offline command
// storage joins this protocol in subsequent Slice 2 steps.
/** Commands per envelope. The real ceiling is the 100-statement atomic plan, checked at plan time. */
export const MAX_BATCH_COMMANDS = 100;
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
/** Set one user preference. expectedRevision is the preference's sync revision; null when no row exists yet. */
export const PreferenceSetCommandSchema = v.strictObject({
  kind: v.literal('preference.set'), key: v.picklist(PREFERENCE_KEYS), value: v.pipe(v.string(), v.maxLength(2_000)),
  expectedRevision: v.nullable(RevisionSchema),
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
export const TaskDeleteCommandSchema = v.strictObject({ kind: v.literal('task.delete'), id: TaskIdSchema, expectedRevision: RevisionSchema, expectedStructuralRevision: RevisionSchema });
export const ProjectDeleteCommandSchema = v.strictObject({ kind: v.literal('project.delete'), id: ProjectIdSchema, expectedRevision: RevisionSchema, expectedStructuralRevision: RevisionSchema });
const linkCommandEntries = { from: TaskIdSchema, to: TaskIdSchema, linkType: LinkTypeSchema, expectedStructuralRevision: RevisionSchema };
export const LinkAddCommandSchema = v.pipe(v.strictObject({ ...linkCommandEntries,
  kind: v.literal('link.add'), expectedRevision: v.nullable(RevisionSchema),
}), v.check(value => value.from !== value.to, 'A task cannot link to itself.'),
v.check(value => value.linkType !== 'related' || value.from < value.to, 'Related additions require ascending endpoint IDs.'));
export const LinkRemoveCommandSchema = v.strictObject({ ...linkCommandEntries, kind: v.literal('link.remove'), expectedRevision: RevisionSchema });
export const CommandEnvelopeSchema = v.pipe(v.strictObject({
  contractVersion: v.literal(2), commandId: CommandIdSchema,
  actor: v.picklist(['user', 'llm', 'import']),
  reason: v.optional(v.pipe(v.string(), v.maxLength(1_000))),
  expectedStructuralRevision: v.optional(RevisionSchema),
  commands: v.pipe(v.array(v.variant('kind', [PlanningCommandSchema, PreferenceSetCommandSchema, ProjectCreateCommandSchema, TaskCreateCommandSchema, ProjectContentCommandSchema, TaskContentCommandSchema, TaskFocusCommandSchema, TaskDeferCommandSchema, TaskReopenCommandSchema, ProjectArchiveCommandSchema, ProjectReopenCommandSchema, TaskCompleteCommandSchema, TaskProjectCommandSchema, TaskTypeCommandSchema, TaskLegacyScheduleCommandSchema, LinkAddCommandSchema, LinkRemoveCommandSchema, TaskDeleteCommandSchema, ProjectDeleteCommandSchema])), v.minLength(1), v.maxLength(MAX_BATCH_COMMANDS)),
}), v.check(value => value.commands.length === 1 ? value.expectedStructuralRevision === undefined
  : value.expectedStructuralRevision !== undefined && value.commands.every(command => command.kind !== 'planning.set' && command.kind !== 'preference.set'),
'Mixed batches require an envelope structural revision; settings remain standalone.'),
v.check(value => { const refs=value.commands.flatMap(command => 'clientRef' in command && command.clientRef !== undefined ? [command.clientRef] : command.kind === 'task.complete' && command.successor?.clientRef !== undefined ? [command.successor.clientRef] : []); return new Set(refs).size === refs.length; }, 'Client references must be unique within a batch.'));
export type CommandEnvelope = v.InferOutput<typeof CommandEnvelopeSchema>;
export const parseCommandEnvelope = (input: unknown) => parseSchema(CommandEnvelopeSchema, input);
export const PayloadHashSchema = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
export const PlanningDiffSchema = v.strictObject({
  entity: v.literal('planning_settings'), id: v.literal('workspace'),
  before: v.nullable(PlanningSettingsSchema), after: PlanningSettingsSchema,
});
export const PreferenceDiffSchema = v.strictObject({
  entity: v.literal('preference'), id: v.picklist(PREFERENCE_KEYS),
  before: v.nullable(v.strictObject({ revision: RevisionSchema, value: v.string() })),
  after: v.strictObject({ revision: RevisionSchema, value: v.string() }),
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
  after: v.union([v.strictObject({ revision: RevisionSchema, row: ProjectRowSchema }), v.strictObject({ revision: RevisionSchema, deleted: v.literal(true) })]),
});
export const TaskChangeDiffSchema = v.strictObject({
  entity: v.literal('task'), id: TaskIdSchema,
  before: v.nullable(v.strictObject({ revision: RevisionSchema, row: TaskRowSchema })),
  after: v.union([v.strictObject({ revision: RevisionSchema, row: TaskRowSchema }), v.strictObject({ revision: RevisionSchema, deleted: v.literal(true) })]),
});
export const LinkChangeDiffSchema = v.strictObject({
  entity: v.literal('link'), id: v.string(),
  before: v.nullable(v.strictObject({ revision: RevisionSchema, row: v.nullable(TaskLinkRowSchema) })),
  after: v.union([v.strictObject({ revision: RevisionSchema, row: TaskLinkRowSchema }), v.strictObject({ revision: RevisionSchema, deleted: v.literal(true) })]),
});
export const ChangeDiffSchema = v.variant('entity', [PlanningDiffSchema, PreferenceDiffSchema, ProjectChangeDiffSchema, TaskChangeDiffSchema, LinkChangeDiffSchema]);
type ChangeDiff = v.InferOutput<typeof ChangeDiffSchema>;

// Group boundaries identify standalone completion effects. Check the entire
// transition, including inherited successor fields, before accepting a receipt
// as canonical state. The date-only recurrence helper is shared with the planner.
function validCompletion(changes: ChangeDiff[], serverNow: string): boolean {
  const [root, successor] = changes;
  if (root?.entity !== 'task' || root.before?.row.status !== 'pending' || !('row' in root.after)) return false;
  const before = root.before.row;
  const completed = { ...before, status: 'done', defer_kind: 'none', defer_until: null, focused_until: null, updated_at: serverNow };
  const completedRow = root.after.row;
  if (!Object.entries(completed).every(([field, stored]) => completedRow[field as keyof typeof completed] === stored)) return false;
  if (before.recurrence === null) return changes.length === 1;
  if (changes.length !== 2 || successor?.entity !== 'task' || successor.before !== null || !('row' in successor.after)
    || before.due_date === null || before.due_all_day === false) return false;
  const rule = parseRrule(before.recurrence);
  const anchor = parseIsoDate(before.due_date.slice(0, 10));
  if (!rule.ok || !anchor.ok) return false;
  try {
    const expected = { ...before, id: successor.id, status: 'pending',
      due_date: `${nextOccurrence(rule.value.parts, anchor.value)}T12:00:00Z`, due_all_day: true,
      created_at: serverNow, updated_at: serverNow, defer_kind: 'none', defer_until: null, focused_until: null,
      kickoff_note: before.session_log ?? before.kickoff_note, session_log: null, duty_id: null, occurrence_at: null };
    const after = successor.after.row;
    return Object.entries(expected).every(([field, stored]) => after[field as keyof typeof after] === stored);
  } catch {
    return false;
  }
}
function validDiffIdentity(value: { serverNow: string; batch?: true | undefined; changeGroups?: number[] | undefined; commandChanges?: number[][] | undefined; changes: v.InferOutput<typeof ChangeDiffSchema>[]; refs: Record<string, string> }): boolean {
  if (value.changes.length === 0) return false;
  if (value.batch !== true && (value.changeGroups !== undefined || value.commandChanges !== undefined)) return false;
  if (value.changeGroups !== undefined && value.commandChanges !== undefined) return false;
  if (value.batch === true) {
    if (value.changes.some(change => change.entity === 'planning_settings' || change.entity === 'preference')) return false;
    // A composed batch (several commands writing one identity) may net down to a single change.
    if (value.commandChanges === undefined && value.changes.length < 2) return false;
    if (value.commandChanges !== undefined) {
      // Each command names the changes it contributed to; some change must be shared, or the
      // batch was not composed and uses changeGroups instead.
      const uses = new Array<number>(value.changes.length).fill(0);
      for (const indexes of value.commandChanges) {
        if (indexes.some((index, at) => index >= value.changes.length || (at > 0 && index <= indexes[at - 1]!))) return false;
        for (const index of indexes) uses[index]!++;
      }
      if (uses.some(count => count === 0) || !uses.some(count => count > 1)) return false;
    } else if (value.changeGroups === undefined) {
      // Receipts from the first mixed-batch release contain only simple images.
      if (value.changes.length > 20 || value.changes.some(change => (change.entity !== 'link' && 'deleted' in change.after) || (change.entity === 'task' && change.before?.row.status === 'pending' && 'row' in change.after && change.after.row.status === 'done'))) return false;
    } else {
      if (value.changeGroups.length < 2 || value.changeGroups.length > MAX_BATCH_COMMANDS || value.changeGroups.reduce((a,b) => a+b,0) !== value.changes.length) return false;
      let offset=0;
      for (const count of value.changeGroups) {
        if (!Number.isSafeInteger(count) || count < 1 || !validDiffIdentity({serverNow:value.serverNow,changes:value.changes.slice(offset,offset+count),refs:{}})) return false;
        offset+=count;
      }
    }
  }
  const identities = new Set<string>();
  const createdIds = new Set<string>();
  for (const change of value.changes) {
    if (identities.has(`${change.entity}:${change.id}`)) return false;
    identities.add(`${change.entity}:${change.id}`);
    if (change.entity === 'planning_settings') return value.changes.length === 1 && Object.keys(value.refs).length === 0;
    if (change.entity === 'preference') {
      // A new preference starts at 1, or one past a retained tombstone; an edit is exactly one step.
      if (change.before !== null && change.after.revision !== change.before.revision + 1) return false;
      return value.changes.length === 1 && Object.keys(value.refs).length === 0;
    }
    if (change.entity === 'link') {
      const row = 'row' in change.after ? change.after.row : change.before?.row;
      if (!row || change.id !== JSON.stringify([row.from_task_id, row.to_task_id, row.link_type])) return false;
      if (change.before === null) { if (change.after.revision !== 1 || !('row' in change.after)) return false; }
      else {
        if (change.after.revision !== change.before.revision + 1) return false;
        if (change.before.row !== null && change.id !== JSON.stringify([change.before.row.from_task_id, change.before.row.to_task_id, change.before.row.link_type])) return false;
        if (!('row' in change.after) && change.before.row === null) return false;
      }
      continue;
    }
    if ('row' in change.after && change.id !== change.after.row.id) return false;
    if (change.before !== null) {
      if (change.id !== change.before.row.id || change.after.revision !== change.before.revision + 1) return false;
    } else {
      if (change.after.revision !== 1 || !('row' in change.after)) return false;
      createdIds.add(change.id);
    }
  }
  if (value.batch !== true) {
    const [root, ...effects] = value.changes;
    if (root?.entity === 'task' && root.before?.row.status === 'pending' && 'row' in root.after && root.after.row.status === 'done') {
      if (!validCompletion(value.changes, value.serverNow)) return false;
    } else if (value.changes.length === 1) {
      // Simple non-completion commands have no derived effects.
    } else if (root?.entity === 'task' && 'deleted' in root.after) {
      if (!effects.every(effect => effect.entity === 'link' && 'deleted' in effect.after && effect.before?.row !== null
        && effect.before !== null && (effect.before.row.from_task_id === root.id || effect.before.row.to_task_id === root.id))) return false;
    } else if (root?.entity === 'project' && 'deleted' in root.after) {
      if (!effects.every(effect => {
        if (effect.entity !== 'task' || !('row' in effect.after) || effect.before?.row.project_id !== root.id) return false;
        const expected = { ...effect.before.row, project_id: null, updated_at: value.serverNow };
        const after = effect.after.row;
        return Object.entries(expected).every(([field, stored]) => after[field as keyof typeof after] === stored);
      })) return false;
    } else {
      return false;
    }
  }
  return Object.keys(value.refs).length <= (value.batch ? MAX_BATCH_COMMANDS : 1) && Object.values(value.refs).every(id => createdIds.has(id));
}
const RefsSchema = v.pipe(v.custom<Record<string, string>>(input => input !== null && typeof input === 'object' && !Array.isArray(input)
  && Object.entries(input).every(([key, value]) => /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(key)
    && !['constructor', 'prototype', '__proto__'].includes(key) && typeof value === 'string'), 'Expected valid client reference keys and IDs.'),
v.record(ClientRefSchema, v.union([TaskIdSchema, ProjectIdSchema])));
const resultEntries = {
  contractVersion: v.literal(2), commandId: CommandIdSchema, payloadHash: PayloadHashSchema,
  serverNow: EventInstantSchema, batch: v.optional(v.literal(true)), changeGroups: v.optional(v.pipe(v.array(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100))), v.minLength(2), v.maxLength(MAX_BATCH_COMMANDS))), commandChanges: v.optional(v.pipe(v.array(v.pipe(v.array(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(99))), v.minLength(1), v.maxLength(100))), v.minLength(2), v.maxLength(MAX_BATCH_COMMANDS))), changes: v.pipe(v.array(ChangeDiffSchema), v.minLength(1), v.maxLength(100)),
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
