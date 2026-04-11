-- v4: Remove 'snoozed' as a task status. Snoozed tasks are now just pending
-- tasks with a future snoozed_until timestamp. Focus and snooze both use the
-- same timestamp-decay pattern — no explicit status cleanup needed.
UPDATE tasks SET status = 'pending' WHERE status = 'snoozed';
