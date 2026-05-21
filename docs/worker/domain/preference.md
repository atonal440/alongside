# worker/src/domain/preference.ts

Domain preference value shapes.

## Types

Defines key-specific value unions for user preferences and the internal `last_session_at` preference. `PreferenceEntry` is the union future storage planners should accept instead of loose `Record<string, string>` values.

The module also exports the allowed value arrays for each user preference key.

## Functions

**`preferenceEntryFromParts(key, value)`** — Parses a raw preference key/value pair into the key-specific `PreferenceEntry` union. `DB.setPreference` and import planning both use this so exported preference rows remain restorable.
