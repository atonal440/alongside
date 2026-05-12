# worker/src/domain/preference.ts

Domain preference value shapes.

## Types

Defines key-specific value unions for user preferences and the internal `last_session_at` preference. `PreferenceEntry` is the union future storage planners should accept instead of loose `Record<string, string>` values.
