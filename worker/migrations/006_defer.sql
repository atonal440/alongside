-- v6: Promote snooze into a first-class defer concept covering both short-term
-- ("hide until date") and indefinite ("someday") deferrals. The single
-- snoozed_until column becomes defer_until, paired with defer_kind to
-- distinguish 'until' (timed) from 'someday' (indefinite). Tasks with no
-- deferral use defer_kind = 'none'. Readiness queries treat a 'until'
-- whose date has passed as ready, mirroring the prior snoozed_until behavior.
ALTER TABLE tasks ADD COLUMN defer_kind TEXT NOT NULL DEFAULT 'none';
UPDATE tasks SET defer_kind = 'until' WHERE snoozed_until IS NOT NULL;
ALTER TABLE tasks RENAME COLUMN snoozed_until TO defer_until;
