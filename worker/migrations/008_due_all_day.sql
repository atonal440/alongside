-- v8: Explicit all-day marker for due_date, replacing the noon-UTC-instant
-- heuristic Stage 1 shipped with (docs/plans/duties/stage-1-schema-and-migration.md).
-- That heuristic inferred "no time was specified" from due_date landing on
-- exactly noon UTC — but a genuinely timed due_date that happens to normalize
-- to the same instant an all-day one would use is indistinguishable from it
-- once stored, so the inference is fundamentally lossy. due_all_day makes the
-- distinction explicit instead of inferred.
--
-- Nullable. Backfilled where it can be known for certain: any due_date NOT
-- at exactly noon UTC was necessarily set with a real time-of-day (Stage 1
-- already let REST/MCP write a full instant, not just a bare date), so it's
-- due_all_day = 0. Rows at exactly noon UTC are left NULL — genuinely
-- ambiguous between "all-day" and "coincidentally timed at noon" — and read
-- as all-day everywhere (see docs/pwa/utils/design.md), same as any new
-- write that doesn't specify due_all_day explicitly.

ALTER TABLE tasks ADD COLUMN due_all_day INTEGER;

UPDATE tasks
SET due_all_day = 0
WHERE due_date IS NOT NULL AND due_date NOT LIKE '%T12:00:00Z';
