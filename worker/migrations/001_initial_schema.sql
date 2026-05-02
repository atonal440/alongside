-- Migration: Initial schema
-- Baseline schema immediately before 002_streamline_schema.sql.

-- Projects must exist before tasks can reference them
CREATE TABLE projects (
  id           TEXT PRIMARY KEY,   -- nanoid, e.g. "p_x7k2m"
  title        TEXT NOT NULL,
  kickoff_note TEXT,
  status       TEXT NOT NULL DEFAULT 'active',  -- 'active' | 'archived'
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE TABLE tasks (
  id            TEXT PRIMARY KEY,   -- nanoid, e.g. "t_x7k2m"
  title         TEXT NOT NULL,
  notes         TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'active' | 'done' | 'snoozed'
  due_date      TEXT,               -- ISO 8601 date string, nullable
  recurrence    TEXT,               -- iCal RRULE string, nullable
  session_id    TEXT,               -- set when activated in a session
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  snoozed_until TEXT,               -- nullable, ISO 8601
  task_type     TEXT NOT NULL DEFAULT 'action',  -- 'action' | 'plan' | 'recurring'
  project_id    TEXT REFERENCES projects(id),
  kickoff_note  TEXT,               -- re-entry ramp: what to do next, not a summary
  session_log   TEXT                -- appended at session close: what happened, decisions made
);

CREATE INDEX idx_tasks_status ON tasks(status);
CREATE INDEX idx_tasks_due_date ON tasks(due_date);
CREATE INDEX idx_tasks_session_id ON tasks(session_id);
CREATE INDEX idx_tasks_project_id ON tasks(project_id);

-- Horizontal dependency graph between tasks
CREATE TABLE task_links (
  from_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  to_task_id   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  link_type    TEXT NOT NULL,
  -- 'blocks'    : from_task must complete before to_task can start
  -- 'related'   : informational, no scheduling implication
  -- 'supersedes': from_task replaces to_task (to_task effectively archived)
  PRIMARY KEY (from_task_id, to_task_id, link_type)
);

-- User preferences (written conversationally, not via settings UI)
CREATE TABLE user_preferences (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Append-only log of every CRUD operation; title is denormalized at write time
-- so entries survive task/project deletion and are identical on every device.
CREATE TABLE action_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  tool_name  TEXT NOT NULL,
  task_id    TEXT,
  title      TEXT NOT NULL,
  detail     TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE oauth_codes (
  code           TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  expires_at     INTEGER NOT NULL
);
