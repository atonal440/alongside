-- Migration: Streamline schema
-- Adds notes column to projects, removes unused complexity.

-- 1. Add notes column to projects
ALTER TABLE projects ADD COLUMN notes TEXT;

-- 2. Migrate task_type 'recurring' to 'action' (recurrence field already handles behavior)
UPDATE tasks SET task_type = 'action' WHERE task_type = 'recurring';

-- 3. Delete any 'supersedes' links (unused)
DELETE FROM task_links WHERE link_type = 'supersedes';

-- 4. Drop unused session_id index (if present)
DROP INDEX IF EXISTS idx_tasks_session_id;
