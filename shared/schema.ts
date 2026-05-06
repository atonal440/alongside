import { sqliteTable, text, integer, primaryKey, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const projects = sqliteTable('projects', {
  id:           text('id').primaryKey(),
  title:        text('title').notNull(),
  notes:        text('notes'),
  kickoff_note: text('kickoff_note'),
  status:       text('status', { enum: ['active', 'archived'] }).notNull().default('active'),
  created_at:   text('created_at').notNull(),
  updated_at:   text('updated_at').notNull(),
});

export const duties = sqliteTable('duties', {
  id:              text('id').primaryKey(),
  title:           text('title').notNull(),
  notes:           text('notes'),
  kickoff_note:    text('kickoff_note'),
  task_type:       text('task_type', { enum: ['action', 'plan'] }).notNull().default('action'),
  project_id:      text('project_id').references(() => projects.id),
  recurrence:      text('recurrence').notNull(),
  due_offset_days: integer('due_offset_days').notNull().default(0),
  active:          integer('active', { mode: 'boolean' }).notNull().default(true),
  next_fire_at:    text('next_fire_at').notNull(),
  last_fired_at:   text('last_fired_at'),
  created_at:      text('created_at').notNull(),
  updated_at:      text('updated_at').notNull(),
});

export const tasks = sqliteTable('tasks', {
  id:            text('id').primaryKey(),
  title:         text('title').notNull(),
  notes:         text('notes'),
  status:        text('status', { enum: ['pending', 'done'] }).notNull().default('pending'),
  due_date:      text('due_date'),
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
  duty_id:       text('duty_id').references(() => duties.id, { onDelete: 'set null' }),
  duty_fire_at:  text('duty_fire_at'),
}, (t) => [
  uniqueIndex('idx_tasks_duty_fire').on(t.duty_id, t.duty_fire_at),
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
