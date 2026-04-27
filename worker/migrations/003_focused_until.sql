-- v3: Add focused_until for time-decaying task focus
-- Focus replaces the session-based activation model. Tasks are "focused" when
-- focused_until > now(). Focus decays automatically — no cleanup needed.

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS focused_until TEXT;

-- Migrate any currently-active tasks to focused (3h window) and revert to pending
UPDATE tasks SET focused_until = strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '+3 hours'), status = 'pending' WHERE status = 'active';
