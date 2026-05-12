# shared/brand.ts

Nominal typing helper for values that are validated once and then carried through the codebase with proof of validation.

## Types

**`Brand<T, K>`** — Intersects a base type with a unique-symbol marker. The marker is object-shaped so multiple brands can be stacked, e.g. `TaskId & ParsedTaskId`.

## Functions

**`unsafeBrand(value)`** — Casts a value to a brand. Use only inside parser/minting functions that have already enforced the invariant.
