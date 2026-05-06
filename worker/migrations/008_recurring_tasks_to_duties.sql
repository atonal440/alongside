-- v8: Convert existing pending recurring tasks into duties. Each task gets a
-- corresponding duty with the same template fields; the task is linked back
-- via duty_id + duty_fire_at so the next materialization recognizes the task
-- as the already-fired instance for that fire date and does not duplicate it.
-- Done tasks are left as-is (their recurrence column is harmless and won't
-- trigger anything now that completeTask no longer reads it).

INSERT OR IGNORE INTO duties (
  id, title, notes, kickoff_note, task_type, project_id,
  recurrence, due_offset_days, active, next_fire_at, created_at, updated_at
)
SELECT
  'd_' || substr(id, 3) AS duty_id,
  title,
  notes,
  kickoff_note,
  task_type,
  project_id,
  recurrence,
  0,
  1,
  COALESCE(due_date, strftime('%Y-%m-%d', 'now')) || 'T00:00:00.000Z' AS next_fire_at,
  COALESCE(created_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) AS created_at,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS updated_at
FROM tasks
WHERE status = 'pending' AND recurrence IS NOT NULL;

UPDATE tasks
SET duty_id      = 'd_' || substr(id, 3),
    duty_fire_at = COALESCE(due_date, strftime('%Y-%m-%d', 'now')) || 'T00:00:00.000Z',
    recurrence   = NULL,
    updated_at   = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE status = 'pending' AND recurrence IS NOT NULL;
