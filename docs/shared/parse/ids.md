# shared/parse/ids.ts

Branded ID types and parsers for task IDs, project IDs, and OAuth one-shot codes.

## Types

**`TaskId`**, **`ProjectId`**, **`OAuthCode`** — General validated ID brands.

**`ParsedTaskId`**, **`ParsedProjectId`** — Source brands for caller-supplied IDs.

**`MintedTaskId`**, **`MintedProjectId`** — Source brands reserved for worker-generated IDs in later slices.

## Schemas And Parsers

**`TaskIdSchema`**, **`ProjectIdSchema`**, **`OAuthCodeSchema`** validate current string formats.

**`parseTaskId`**, **`parseProjectId`**, **`parseOAuthCode`** return `Result` values with structured validation errors.
