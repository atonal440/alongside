# Alongside — Documentation Overview

Alongside is a lightweight, offline-first task manager built around conversational workflow with Claude. It consists of three main parts: a **Cloudflare Worker** backend (REST API + MCP endpoint + iframe widget), a **React PWA** frontend (local-first with IndexedDB), and a **shared types** layer used by both.

## Directory structure

```
docs/
  overview.md          ← this file
  shared/
    schema.md          ← shared/schema.ts
    types.md           ← shared/types.ts
  worker/
    index.md           ← worker/src/index.ts
    db.md              ← worker/src/db.ts
    api.md             ← worker/src/api.ts
    mcp.md             ← worker/src/mcp.ts
    ui.md              ← worker/src/ui.ts
    oauth.md           ← worker/src/oauth.ts
    sign.md            ← worker/src/sign.ts
    app-ui.md          ← worker/src/app-ui.ts
    dev-harness.md     ← worker/src/dev-harness.ts
  pwa/
    app.md             ← pwa/src/App.tsx
    main.md            ← pwa/src/main.tsx
    sw.md              ← pwa/src/sw.ts
    types.md           ← pwa/src/types.ts
    context/
      AppContext.md    ← pwa/src/context/AppContext.tsx
      reducer.md       ← pwa/src/context/reducer.ts
      actions.md       ← pwa/src/context/actions.ts
    idb/
      db.md            ← pwa/src/idb/db.ts
      tasks.md         ← pwa/src/idb/tasks.ts
      projects.md      ← pwa/src/idb/projects.ts
      links.md         ← pwa/src/idb/links.ts
      pendingOps.md    ← pwa/src/idb/pendingOps.ts
    api/
      client.md        ← pwa/src/api/client.ts
      sync.md          ← pwa/src/api/sync.ts
    hooks/
      useAppState.md   ← pwa/src/hooks/useAppState.ts
      useSync.md       ← pwa/src/hooks/useSync.ts
      useHistory.md    ← pwa/src/hooks/useHistory.ts
    utils/
      genId.md         ← pwa/src/utils/genId.ts
      design.md        ← pwa/src/utils/design.ts
      linkMaps.md      ← pwa/src/utils/linkMaps.ts
      suggestQueue.md  ← pwa/src/utils/suggestQueue.ts
      taskFlow.md      ← pwa/src/utils/taskFlow.ts
    components/
      layout/
        Sidebar.md     ← pwa/src/components/layout/Sidebar.tsx
        Header.md      ← pwa/src/components/layout/Header.tsx
        NavBar.md      ← pwa/src/components/layout/NavBar.tsx
        SyncStatus.md  ← pwa/src/components/layout/SyncStatus.tsx
      common/
        AddBar.md      ← pwa/src/components/common/AddBar.tsx
        EmptyState.md  ← pwa/src/components/common/EmptyState.tsx
        SettingsBanner.md ← pwa/src/components/common/SettingsBanner.tsx
        Toast.md       ← pwa/src/components/common/Toast.tsx
      task/
        CompactCard.md ← pwa/src/components/task/CompactCard.tsx
        TaskCard.md    ← pwa/src/components/task/TaskCard.tsx
        TaskMeta.md    ← pwa/src/components/task/TaskMeta.tsx
        TaskStack.md   ← pwa/src/components/task/TaskStack.tsx
      views/
        AllView.md     ← pwa/src/components/views/AllView.tsx
        DetailView.md  ← pwa/src/components/views/DetailView.tsx
        EditView.md    ← pwa/src/components/views/EditView.tsx
        SessionView.md ← pwa/src/components/views/SessionView.tsx
        SuggestView.md ← pwa/src/components/views/SuggestView.tsx
```

## How data flows

1. User actions in the PWA write to IndexedDB immediately (optimistic local state).
2. `flushPendingOps` sends queued operations to the Worker REST API when online.
3. `syncFromServer` pulls server state back down and reconciles with local IndexedDB (last-write-wins on `updated_at`).
4. The Worker persists everything in Cloudflare D1 (SQLite) and exposes the same data over the MCP endpoint for Claude integrations.
