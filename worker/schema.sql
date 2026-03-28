CREATE TABLE IF NOT EXISTS tasks (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  notes         TEXT,
  status        TEXT NOT NULL DEFAULT 'pending',
  due_date      TEXT,
  recurrence    TEXT,
  session_id    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  snoozed_until TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_session_id ON tasks(session_id);
