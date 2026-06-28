# Design Sync Notes

## Repo-specific setup

- **No published library dist** — this is a PWA app, not a library. The converter uses a synthetic
  barrel entry at `pwa/src/ds-entry.ts` that re-exports all components + AppProvider.
- **PKG_DIR = `pwa/`** — because `--entry pwa/src/ds-entry.ts` causes the converter to walk up
  to `pwa/package.json`. All `design-sync.config.json` paths (`srcDir`, `tsconfig`, `cssEntry`,
  `componentSrcMap`) are therefore relative to `pwa/`, not the repo root.
- **`@shared/*` alias** resolves via `pwa/tsconfig.app.json` → `../shared/*`. esbuild's
  tsconfigPathsPlugin handles it.
- **AppProvider** is bundled as a component (via `componentSrcMap`) and used as the preview
  provider (`cfg.provider.component: "AppProvider"`). It gracefully degrades to empty state
  in preview env because `window.location.hostname` ≠ `"localhost"` (preview server is 127.0.0.1),
  so `apiBase = ""` → `isConfigured = false` → no IDB calls.
- **rrule** is bundled (pulled in via `AddBar` → `domain/taskForm` → `@shared/parse`). It's in
  `pwa/node_modules/rrule/dist/esm/index.js` ✓.
- **drizzle-orm** is in the tsconfig paths but never imported at runtime — all shared/schema
  imports are type-only. Not bundled.

## Build command

```bash
node .ds-sync/package-build.mjs --config design-sync.config.json \
  --node-modules pwa/node_modules --entry pwa/src/ds-entry.ts --out ./ds-bundle
```

Re-copy scripts first (`cp -r <skill-base>/...` from SKILL.md §7) to pick up converter updates.

## Preview scope (first sync 2026-06-28)

Rich authored previews planned for 13 core components:
- Common: EmptyState, AddBar, SearchBar, Markdown, SettingsBanner, Header, NavBar
- Task: TaskCard, CompactCard, TaskMeta, TaskStack, DeferMenu
- Toast → floor card (context-driven, no props to control visible state)
- Sidebar, SyncStatus → floor cards (context-heavy, not in authored scope)
- All 5 views → floor cards (full app screens, authorable on re-sync)

## Re-sync risks

- `pwa/src/ds-entry.ts` is the barrel — must be updated when new components are added to the app.
- `AppProvider` behavior in preview depends on `window.location.hostname ≠ "localhost"`. If the
  preview server ever changes to a localhost domain, AppProvider will start making IDB calls.
  Watch for `[RENDER]` errors on context-dependent components (Toast, NavBar, etc.) if this happens.
- `pwa/src/index.css` is the CSS entry — the design token set. When tokens change, rebuild+re-upload.
- No compiled `.d.ts` files exist → props bodies are synthesized from source via ts-morph. If a
  component's prop interface uses complex generics or cross-package types, `cfg.dtsPropsFor` may
  be needed.
