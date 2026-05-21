# worker/src/domain/project.ts

Domain project shape for the worker type-safety migration.

## Types

**`ProjectDomain`** — Project entity with branded ID, title, status, timestamps, and bounded optional notes.

## Functions

**`projectFromRow(row)`** — Fallible row/domain codec for project rows. It validates project id format, non-empty title length, optional notes/kickoff bounds, status, and timestamps. `DB.createProject` and `DB.updateProject` use this before writes so the worker cannot export project rows that its import parser would reject.
