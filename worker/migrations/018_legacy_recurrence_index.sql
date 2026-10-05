-- Legacy recurring tasks awaiting adoption into duties; keeps the per-read adoption check an index probe.
CREATE INDEX IF NOT EXISTS tasks_legacy_recurrence ON tasks(id) WHERE status = 'pending' AND recurrence IS NOT NULL AND duty_id IS NULL;
