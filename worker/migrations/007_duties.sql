-- v7: Duties (docs/plans/duties.md) — first-class recurring-series anchor,
-- plus the app-wide timestamp unification (Decision 4: no more date-only
-- scheduling fields, minute-resolution UTC everywhere).
--
-- due_date rewrite: existing date-only values ("YYYY-MM-DD") migrate to
-- noon UTC ("YYYY-MM-DDT12:00:00Z"), not midnight. A date-only value meant
-- "this calendar day"; the app renders instants in the viewer's local zone,
-- so midnight UTC would display a day early west of UTC. Noon UTC keeps the
-- displayed calendar date stable for viewer offsets UTC-12..+11. See
-- docs/plans/duties/02-timestamp-model.md "Migrated". Deterministic,
-- lossy-forward — do not run this twice against the same row (the WHERE
-- clause below is idempotent: only touches values that still lack a "T").
--
-- No duty rows are created and no task.duty_id is set here — the backfill
-- that turns legacy recurring tasks into duties lands in Stage 4, once
-- parseSeriesRrule and dutyFromRow exist to validate every row it writes.

UPDATE tasks
SET due_date = due_date || 'T12:00:00Z'
WHERE due_date IS NOT NULL AND due_date NOT LIKE '%T%';

CREATE TABLE IF NOT EXISTS duties (
  id                 TEXT PRIMARY KEY,
  title              TEXT NOT NULL,
  notes              TEXT,
  kickoff_note       TEXT,
  task_type          TEXT NOT NULL DEFAULT 'action',
  project_id         TEXT REFERENCES projects(id),
  rrule              TEXT NOT NULL,
  dtstart            TEXT NOT NULL,
  timezone           TEXT,
  status             TEXT NOT NULL DEFAULT 'active',
  catch_up           TEXT NOT NULL DEFAULT 'next',
  last_spawned_at    TEXT,
  next_occurrence_at TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS duties_next_occurrence_at ON duties(next_occurrence_at);

ALTER TABLE tasks ADD COLUMN duty_id TEXT REFERENCES duties(id);
ALTER TABLE tasks ADD COLUMN occurrence_at TEXT;

-- SQLite treats NULLs as distinct in a UNIQUE index, so every duty_id IS NULL
-- row (i.e. every task today) is unconstrained by this index.
CREATE UNIQUE INDEX IF NOT EXISTS tasks_duty_occurrence ON tasks(duty_id, occurrence_at);

ALTER TABLE action_log ADD COLUMN duty_id TEXT;
