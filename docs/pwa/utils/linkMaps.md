# pwa/src/utils/linkMaps.ts

Utilities for turning the flat `TaskLink[]` array into lookup maps used by the UI to show blocking relationships.

## Functions

**`buildBlocksMap(links)`** — Takes the full links array and returns a `Map<taskId, Task[]>` where each key maps to the tasks that the keyed task blocks (i.e. tasks downstream of it).

**`buildBlockedByMap(links)`** — Returns a `Map<taskId, Task[]>` where each key maps to the tasks that are blocking the keyed task (i.e. tasks upstream of it). Used in `DetailView` and `EditView` to display dependency relationships.

## See Also

- [[idb-links|pwa/src/idb/links.ts]] — source of the `TaskLink[]` array these maps are built from
- [[DetailView]] — renders "Blocked by" and "Unlocks" groups using these maps
- [[AllView]] — uses `buildBlocksMap` to group tasks under their blockers
- [[readiness]] — `hasActiveBlocker` also scans links but in a different shape
