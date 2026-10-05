import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, real, primaryKey, uniqueIndex, index, check } from 'drizzle-orm/sqlite-core';

export const projects = sqliteTable('projects', {
  id:           text('id').primaryKey(),
  title:        text('title').notNull(),
  notes:        text('notes'),
  kickoff_note: text('kickoff_note'),
  status:       text('status', { enum: ['active', 'archived'] }).notNull().default('active'),
  created_at:   text('created_at').notNull(),
  updated_at:   text('updated_at').notNull(),
});

// A duty is a recurring series' anchor: rrule + dtstart + timezone define its
// occurrence calendar and are immutable after creation (reschedule/re-zone is
// end_duty + create_duty — see docs/plans/duties/02-timestamp-model.md).
// last_spawned_at is a monotonic cursor; next_occurrence_at drives the
// due-gate and is indexed for it. No occurrences ledger — see docs/plans/duties.md.
export const duties = sqliteTable('duties', {
  id:                 text('id').primaryKey(),
  title:              text('title').notNull(),
  notes:              text('notes'),
  kickoff_note:       text('kickoff_note'),
  task_type:          text('task_type', { enum: ['action', 'plan'] }).notNull().default('action'),
  project_id:         text('project_id').references(() => projects.id),
  rrule:              text('rrule').notNull(),
  dtstart:            text('dtstart').notNull(),
  timezone:           text('timezone'),
  status:             text('status', { enum: ['active', 'paused', 'ended'] }).notNull().default('active'),
  catch_up:           text('catch_up', { enum: ['next', 'all'] }).notNull().default('next'),
  last_spawned_at:    text('last_spawned_at'),
  next_occurrence_at: text('next_occurrence_at'),
  created_at:         text('created_at').notNull(),
  updated_at:         text('updated_at').notNull(),
}, (t) => [
  index('duties_next_occurrence_at').on(t.next_occurrence_at),
]);

export const tasks = sqliteTable('tasks', {
  id:            text('id').primaryKey(),
  title:         text('title').notNull(),
  notes:         text('notes'),
  status:        text('status', { enum: ['pending', 'done'] }).notNull().default('pending'),
  due_date:      text('due_date'),
  // Explicit all-day marker — replaces inferring "no time was specified"
  // from due_date's instant (unrecoverable once stored: a genuinely timed
  // due_date that happens to normalize to the same instant an all-day one
  // would use is indistinguishable from it). Null on legacy/pre-migration
  // rows; treated as "all-day" (true) wherever read. See
  // docs/plans/duties-implementation-todo.md "Notes / deviations".
  due_all_day:   integer('due_all_day', { mode: 'boolean' }),
  recurrence:    text('recurrence'),
  created_at:    text('created_at').notNull(),
  updated_at:    text('updated_at').notNull(),
  defer_until:   text('defer_until'),
  defer_kind:    text('defer_kind', { enum: ['none', 'until', 'someday'] }).notNull().default('none'),
  task_type:     text('task_type', { enum: ['action', 'plan'] }).notNull().default('action'),
  project_id:    text('project_id').references(() => projects.id),
  kickoff_note:  text('kickoff_note'),
  session_log:   text('session_log'),
  focused_until: text('focused_until'),
  duty_id:       text('duty_id').references(() => duties.id),
  occurrence_at: text('occurrence_at'),
  // Date roles beyond the target (due_date): canonical TemporalPoint JSON text,
  // see migration 015 and docs/plans/power-user-todo.md. Null = not set.
  available_from: text('available_from'),
  deadline:      text('deadline'),
  // Hierarchy (migration 016): parent task id and sibling sort key.
  parent_id:     text('parent_id'),
  position:      real('position'),
}, (t) => [
  uniqueIndex('tasks_duty_occurrence').on(t.duty_id, t.occurrence_at),
  index('tasks_legacy_recurrence').on(t.id).where(sql`${t.status} = 'pending' AND ${t.recurrence} IS NOT NULL AND ${t.duty_id} IS NULL`),
  index('idx_tasks_status').on(t.status),
  index('idx_tasks_due_date').on(t.due_date),
  index('idx_tasks_project_id').on(t.project_id),
]);

export const taskLinks = sqliteTable('task_links', {
  from_task_id: text('from_task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  to_task_id:   text('to_task_id').notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  link_type:    text('link_type', { enum: ['blocks', 'related'] }).notNull(),
}, (t) => [
  primaryKey({ columns: [t.from_task_id, t.to_task_id, t.link_type] }),
]);

export const userPreferences = sqliteTable('user_preferences', {
  key:   text('key').primaryKey(),
  value: text('value').notNull(),
});

export const actionLog = sqliteTable('action_log', {
  id:         integer('id').primaryKey({ autoIncrement: true }),
  tool_name:  text('tool_name').notNull(),
  task_id:    text('task_id'),
  duty_id:    text('duty_id'),
  title:      text('title').notNull(),
  detail:     text('detail'),
  created_at: text('created_at').notNull(),
});

export const oauthCodes = sqliteTable('oauth_codes', {
  code:           text('code').primaryKey(),
  client_id:      text('client_id').notNull(),
  redirect_uri:   text('redirect_uri').notNull(),
  code_challenge: text('code_challenge').notNull(),
  expires_at:     integer('expires_at').notNull(),
});

export type Task      = typeof tasks.$inferSelect;
export type Project   = typeof projects.$inferSelect;
export type TaskLink  = typeof taskLinks.$inferSelect;
export type ActionLog = typeof actionLog.$inferSelect;
export type Duty      = typeof duties.$inferSelect;

// Empty until explicitly configured through reliable commands. This foundation
// has read/preview APIs only; it does not silently adopt the host's timezone.
export const planningSettings = sqliteTable('planning_settings', {
  id: integer('id').primaryKey(),
  timezone: text('timezone').notNull(),
  buffer_minutes: integer('buffer_minutes').notNull().default(0),
  revision: integer('revision').notNull().default(0),
  created_at: text('created_at').notNull(),
  updated_at: text('updated_at').notNull(),
}, t => [
  check('planning_settings_singleton', sql`${t.id} = 1`),
  check('planning_settings_buffer', sql`typeof(${t.buffer_minutes}) = 'integer' AND ${t.buffer_minutes} BETWEEN 0 AND 1440`),
  check('planning_settings_revision', sql`typeof(${t.revision}) = 'integer' AND ${t.revision} BETWEEN 0 AND 9007199254740991`),
]);
export const planningWorkingHours = sqliteTable('planning_working_hours', {
  settings_id: integer('settings_id').notNull().references(() => planningSettings.id, { onDelete: 'cascade' }),
  weekday: integer('weekday').notNull(),
  start_time: text('start_time').notNull(),
  end_time: text('end_time').notNull(),
}, t => [
  primaryKey({ columns: [t.settings_id, t.weekday, t.start_time] }),
  check('planning_hours_singleton', sql`${t.settings_id} = 1`),
  check('planning_hours_weekday', sql`typeof(${t.weekday}) = 'integer' AND ${t.weekday} BETWEEN 1 AND 7`),
  check('planning_hours_start', sql`${t.start_time} GLOB '[0-2][0-9]:[0-5][0-9]' AND ${t.start_time} < '24:00'`),
  check('planning_hours_end', sql`${t.end_time} GLOB '[0-2][0-9]:[0-5][0-9]' AND ${t.end_time} < '24:00' AND ${t.end_time} > ${t.start_time}`),
]);

// Receipts never expire automatically: offline replay must remain safe. The
// command feed covers settings and reliable creation; not legacy/delta sync.
export const commandReceipts = sqliteTable('command_receipts', {
  command_id: text('command_id').primaryKey().notNull(),
  payload_hash: text('payload_hash').notNull(),
  result_json: text('result_json').notNull(),
  created_at: text('created_at').notNull(),
}, t => [
  check('receipt_hash', sql`length(${t.payload_hash}) = 64 AND ${t.payload_hash} NOT GLOB '*[^0-9a-f]*'`),
  check('receipt_result', sql`json_valid(${t.result_json})`),
]);
export const commandAudit = sqliteTable('command_audit', {
  command_id: text('command_id').primaryKey().notNull().references(() => commandReceipts.command_id),
  actor: text('actor', { enum: ['user', 'llm', 'import', 'system'] }).notNull(),
  reason: text('reason'), changes_json: text('changes_json').notNull(), created_at: text('created_at').notNull(),
}, t => [
  check('command_actor', sql`${t.actor} IN ('user','llm','import','system')`),
  check('command_changes', sql`json_valid(${t.changes_json})`),
]);
export const changeFeed = sqliteTable('change_feed', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  command_id: text('command_id').notNull().references(() => commandReceipts.command_id),
  entity: text('entity', { enum: ['planning_settings', 'task', 'project', 'link', 'duty'] }).notNull(),
  entity_id: text('entity_id').notNull(), revision: integer('revision').notNull(),
  operation: text('operation', { enum: ['upsert', 'delete'] }).notNull(),
  payload_json: text('payload_json').notNull(), created_at: text('created_at').notNull(),
}, t => [
  check('feed_entity', sql`(${t.entity} = 'planning_settings' AND ${t.entity_id} = 'workspace') OR (${t.entity} = 'task' AND ${t.entity_id} GLOB 't_*') OR (${t.entity} = 'project' AND ${t.entity_id} GLOB 'p_*') OR (${t.entity} = 'duty' AND ${t.entity_id} GLOB 'd_*') OR (${t.entity} = 'link' AND CASE WHEN json_valid(${t.entity_id}) THEN json_type(${t.entity_id}) = 'array' AND json_array_length(${t.entity_id}) = 3 AND json_type(${t.entity_id},'$[0]') = 'text' AND json_extract(${t.entity_id},'$[0]') GLOB 't_*' AND json_type(${t.entity_id},'$[1]') = 'text' AND json_extract(${t.entity_id},'$[1]') GLOB 't_*' AND json_type(${t.entity_id},'$[2]') = 'text' AND json_extract(${t.entity_id},'$[2]') IN ('blocks','related') ELSE 0 END)`),
  check('feed_revision', sql`typeof(${t.revision}) = 'integer' AND ${t.revision} BETWEEN 0 AND 9007199254740991`),
  check('feed_operation', sql`${t.operation} IN ('upsert','delete')`),
  check('feed_payload', sql`json_valid(${t.payload_json})`),
  index('change_feed_entity').on(t.entity, t.entity_id, t.seq),
]);

// Storage triggers advance these for every legacy/Plan/raw SQL row writer.
// Keeping versions out of legacy rows preserves their wire and IDB contracts.
export const workspaceVersions = sqliteTable('workspace_versions', {
  id: integer('id').primaryKey(),
  structural_revision: integer('structural_revision').notNull().default(0),
}, t => [
  check('workspace_versions_singleton', sql`${t.id} = 1`),
  check('workspace_versions_revision', sql`typeof(${t.structural_revision}) = 'integer' AND ${t.structural_revision} BETWEEN 0 AND 9007199254740991`),
]);
export const entityVersions = sqliteTable('entity_versions', {
  entity: text('entity', { enum: ['task', 'project', 'link', 'duty'] }).notNull(),
  entity_key: text('entity_key').notNull(),
  revision: integer('revision').notNull(),
  deleted_at: text('deleted_at'),
}, t => [
  primaryKey({ columns: [t.entity, t.entity_key] }),
  check('entity_versions_entity', sql`${t.entity} IN ('task','project','link','duty')`),
  check('entity_versions_revision', sql`typeof(${t.revision}) = 'integer' AND ${t.revision} BETWEEN 0 AND 9007199254740991`),
]);

// Independent of command receipts: triggers cover legacy, reliable and raw SQL
// writers. Cursors use an import epoch and a fixed sequence watermark; removing
// history advances the retention floor without expiring receipts or tombstones.
export const syncMetadata = sqliteTable('sync_metadata', {
  id: integer('id').primaryKey(),
  epoch: integer('epoch').notNull().default(0),
  watermark: integer('watermark').notNull().default(0),
  retention_floor: integer('retention_floor').notNull().default(0),
}, t => [
  check('sync_metadata_singleton', sql`${t.id} = 1`),
  check('sync_metadata_epoch', sql`typeof(${t.epoch}) = 'integer' AND ${t.epoch} BETWEEN 0 AND 9007199254740991`),
  check('sync_metadata_watermark', sql`typeof(${t.watermark}) = 'integer' AND ${t.watermark} BETWEEN 0 AND 9007199254740991`),
  check('sync_metadata_floor', sql`typeof(${t.retention_floor}) = 'integer' AND ${t.retention_floor} BETWEEN 0 AND ${t.watermark}`),
]);
export const syncAuxVersions = sqliteTable('sync_aux_versions', {
  entity: text('entity', { enum: ['preference', 'planning_settings', 'action_log', 'command_audit'] }).notNull(),
  entity_key: text('entity_key').notNull(),
  revision: integer('revision').notNull(),
  deleted_at: text('deleted_at'),
}, t => [
  primaryKey({ columns: [t.entity, t.entity_key] }),
  check('sync_aux_entity', sql`${t.entity} IN ('preference','planning_settings','action_log','command_audit')`),
  check('sync_aux_revision', sql`typeof(${t.revision}) = 'integer' AND ${t.revision} BETWEEN 0 AND 9007199254740991`),
]);
export const syncFeed = sqliteTable('sync_feed', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  epoch: integer('epoch').notNull(),
  entity: text('entity', { enum: ['task', 'project', 'link', 'duty', 'preference', 'planning_settings', 'action_log', 'command_audit'] }).notNull(),
  entity_key: text('entity_key').notNull(),
  revision: integer('revision').notNull(),
  operation: text('operation', { enum: ['upsert', 'delete'] }).notNull(),
  row_json: text('row_json').notNull(),
  deleted_at: text('deleted_at'),
  recorded_at: text('recorded_at').notNull(),
}, t => [
  check('sync_feed_seq', sql`typeof(${t.seq}) = 'integer' AND ${t.seq} BETWEEN 1 AND 9007199254740991`),
  check('sync_feed_epoch', sql`typeof(${t.epoch}) = 'integer' AND ${t.epoch} BETWEEN 0 AND 9007199254740991`),
  check('sync_feed_entity', sql`${t.entity} IN ('task','project','link','duty','preference','planning_settings','action_log','command_audit')`),
  check('sync_feed_revision', sql`typeof(${t.revision}) = 'integer' AND ${t.revision} BETWEEN 0 AND 9007199254740991`),
  check('sync_feed_operation', sql`${t.operation} IN ('upsert','delete')`),
  check('sync_feed_row', sql`json_valid(${t.row_json})`),
  index('sync_feed_entity').on(t.entity, t.entity_key, t.seq),
]);
