# pwa/src/components/task/TaskStack.tsx

## Components

**`TaskStack`** — Unified card component for a root task and its blocking chain. Renders as a single card with three sections: (1) the root task row (checkbox + tappable title → detail), (2) an optional expanded list of linked tasks (each tappable → detail, with a `›` indicator), and (3) a full-width footer strip (`▸ N linked` / `▾ N linked`) that toggles the expanded state. Uses local `useState` for open/closed. Reuses `.cc-check`, `.cc-label`, `.cc-meta` CSS from `CompactCard`. Used in `AllView` wherever a task has in-section blocking relationships.
