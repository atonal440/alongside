-- v8: Legacy task-level recurrence is converted lazily by the worker request
-- path, not here. D1 migrations run in SQLite without IANA timezone support,
-- so converting date-only due dates in SQL would shift wall-clock schedules for
-- users outside UTC. The worker uses user_preferences.timezone and links each
-- existing pending recurring task to a deterministic duty before materializing.
SELECT 1;
