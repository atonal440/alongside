-- v8: Explicit all-day marker for due_date, replacing the noon-UTC-instant
-- heuristic Stage 1 shipped with (docs/plans/duties/stage-1-schema-and-migration.md).
-- That heuristic inferred "no time was specified" from due_date landing on
-- exactly noon UTC — but a genuinely timed due_date that happens to normalize
-- to the same instant an all-day one would use is indistinguishable from it
-- once stored, so the inference is fundamentally lossy. due_all_day makes the
-- distinction explicit instead of inferred.
--
-- Nullable, not backfilled: every pre-existing row predates any way to set a
-- genuinely timed due_date via this app's own UI, so NULL is correctly read
-- as "all-day" everywhere (see docs/pwa/utils/design.md). New writes always
-- store an explicit 0/1.

ALTER TABLE tasks ADD COLUMN due_all_day INTEGER;
