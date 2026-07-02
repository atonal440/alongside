import { sqliteTable, text, integer, primaryKey, uniqueIndex, index } from 'drizzle-orm/sqlite-core';

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
}, (t) => [
  uniqueIndex('tasks_duty_occurrence').on(t.duty_id, t.occurrence_at),
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
