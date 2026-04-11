-- v5: Remove 'active' as a task status. Tasks are now either 'pending' or 'done'.
-- Focus (focused_until) replaced active in the prior migration.
UPDATE tasks SET status = 'pending' WHERE status = 'active';
