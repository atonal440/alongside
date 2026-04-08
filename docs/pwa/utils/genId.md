# pwa/src/utils/genId.ts

## Functions

**`genId(prefix)`** — Generates a short random ID with a typed prefix (e.g. `t_Ab12x` for tasks, `p_Xy34z` for projects). Uses URL-safe characters from `Math.random`. Used to create temp IDs for offline-created records before the server assigns a real one.
