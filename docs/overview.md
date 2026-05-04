---
tags: [overview]
---

# Alongside — Documentation Overview

Alongside is a lightweight, offline-first task manager built around conversational workflow with Claude. It consists of three main parts: a **Cloudflare Worker** backend (REST API + MCP endpoint + OAuth 2.1 server + iframe widget), a **React PWA** frontend (local-first with IndexedDB), and a **shared types/readiness** layer used by both.

## Feature highlights

- **Offline-first PWA** — all reads and writes go to IndexedDB first; changes sync to the server when online via [[sync|pwa/api/sync.ts]]
- **Task deferral** — hide tasks until a specific date (`defer_kind: 'until'`) or indefinitely (`defer_kind: 'someday'`); the [[DeferMenu]] offers Tomorrow / Next week / 2 weeks / Someday / pick-a-date presets
- **Focus with auto-decay** — any task can be set focused for a time window (`focused_until` timestamp); expired-focus tasks surface in the [[ReviewView]] Carry Forward panel
- **Readiness scoring** — [[readiness|shared/readiness.ts]] determines whether a task is actionable (pending, not deferred, no active blocker); the worker's [[db|worker/db.ts]] extends this with a numeric score (+3 base, +3 kickoff note, +2 session log, +1 due within 7 days, +1 recently active)
- **Task dependencies / blocking** — `blocks` links hide the downstream task from ready lists until the upstream task completes; `related` links are informational
- **Action log** — every mutation (create, update, complete, delete, defer, link) appends a row to the `action_log` table; readable via `GET /api/action-log` or `get_action_log` MCP tool
- **Search / command palette** — the [[SearchBar]] component (activated by `/` or `Cmd K`) lets users search tasks and projects, run inline actions (focus, complete, defer, edit), or create a new task from any view
- **Review view** — the [[ReviewView]] is an end-of-day close-out surface with four panels: Current Focus, Done Today, Carry Forward, and Next Suggestion
- **OAuth 2.1 / PKCE** — the [[oauth|worker/oauth.ts]] module implements dynamic client registration and the full PKCE authorization code flow so Claude.ai and other external MCP clients can authenticate without sharing the static `AUTH_TOKEN`
- **User preferences** — key-value store for per-user settings: `sort_by`, `urgency_visibility`, `kickoff_nudge`, `session_log`, `interruption_style`, `planning_prompt`; applied at session start
- **Recurrence (iCal RRULE)** — tasks can carry a `recurrence` field (e.g. `FREQ=WEEKLY;INTERVAL=1`); completing a recurring task auto-creates the next occurrence and carries the `session_log` forward as `kickoff_note`
- **Import / export** — `GET /api/export` returns a full JSON snapshot; `POST /api/import` (with optional `?dry_run=true`) restores from a snapshot
- **MCP integration** — 20 tools over JSON-RPC at `/mcp` for Claude and other MCP clients; see [[mcp-tools]] for the full reference

## How data flows

```
User action in PWA
       │
       ▼
IndexedDB write (optimistic, local-first)
       │
       ▼  React state dispatch (reducer)
       │
       ├─► flushPendingOps ──────────────────► Worker REST API (/api/*)
       │     (queued if offline)                      │
       │                                              ▼
       └─► syncFromServer ◄──────────────────  Cloudflare D1 (SQLite)
             (full pull, last-write-wins               │
              on updated_at)                           │
                                               ┌───────┴──────────┐
                                               │                  │
                                               ▼                  ▼
                                        MCP endpoint        OAuth 2.1
                                          (/mcp)           (/oauth/*)
                                               │
                                               ▼
                                        Claude / external
                                            client
```

Local IndexedDB is always written first. [[sync|pwa/api/sync.ts]] replays queued ops when the network is available (`flushPendingOps`) and pulls a full snapshot (`syncFromServer`) for reconciliation. The Worker's [[db|worker/db.ts]] is the authoritative store; the same data is exposed over the MCP endpoint via [[mcp|worker/mcp.ts]]. External clients (e.g. Claude.ai) go through [[oauth|worker/oauth.ts]] before reaching `/mcp`.

## Directory structure

```
docs/
  overview.md              ← this file
  api.md                   ← REST API reference
  mcp-tools.md             ← MCP tool reference
  shared/
    schema.md              ← shared/schema.ts
    types.md               ← shared/types.ts
    readiness.md           ← shared/readiness.ts
  worker/
    index.md               ← worker/src/index.ts
    db.md                  ← worker/src/db.ts
    api.md                 ← worker/src/api.ts
    mcp.md                 ← worker/src/mcp.ts
    ui.md                  ← worker/src/ui.ts
    oauth.md               ← worker/src/oauth.ts
    sign.md                ← worker/src/sign.ts
    app-ui.md              ← worker/src/app-ui.ts
    dev-harness.md         ← worker/src/dev-harness.ts
  pwa/
    overview.md            ← PWA code structure and design principles
    app.md                 ← pwa/src/App.tsx
    main.md                ← pwa/src/main.tsx
    sw.md                  ← pwa/src/sw.ts
    types.md               ← pwa/src/types.ts
    context/
      AppContext.md        ← pwa/src/context/AppContext.tsx
      reducer.md           ← pwa/src/context/reducer.ts
      actions.md           ← pwa/src/context/actions.ts
    idb/
      db.md                ← pwa/src/idb/db.ts
      tasks.md             ← pwa/src/idb/tasks.ts
      projects.md          ← pwa/src/idb/projects.ts
      links.md             ← pwa/src/idb/links.ts
      pendingOps.md        ← pwa/src/idb/pendingOps.ts
    api/
      client.md            ← pwa/src/api/client.ts
      sync.md              ← pwa/src/api/sync.ts
    hooks/
      useAppState.md       ← pwa/src/hooks/useAppState.ts
      useSync.md           ← pwa/src/hooks/useSync.ts
      useHistory.md        ← pwa/src/hooks/useHistory.ts
    utils/
      genId.md             ← pwa/src/utils/genId.ts
      design.md            ← pwa/src/utils/design.ts
      linkMaps.md          ← pwa/src/utils/linkMaps.ts
      suggestQueue.md      ← pwa/src/utils/suggestQueue.ts
      taskFlow.md          ← pwa/src/utils/taskFlow.ts
    components/
      layout/
        Sidebar.md         ← pwa/src/components/layout/Sidebar.tsx
        Header.md          ← pwa/src/components/layout/Header.tsx
        NavBar.md          ← pwa/src/components/layout/NavBar.tsx
        SyncStatus.md      ← pwa/src/components/layout/SyncStatus.tsx
      common/
        AddBar.md          ← pwa/src/components/common/AddBar.tsx
        EmptyState.md      ← pwa/src/components/common/EmptyState.tsx
        Markdown.md        ← pwa/src/components/common/Markdown.tsx
        SearchBar.md       ← pwa/src/components/common/SearchBar.tsx
        SettingsBanner.md  ← pwa/src/components/common/SettingsBanner.tsx
        Toast.md           ← pwa/src/components/common/Toast.tsx
      task/
        CompactCard.md     ← pwa/src/components/task/CompactCard.tsx
        DeferMenu.md       ← pwa/src/components/task/DeferMenu.tsx
        TaskCard.md        ← pwa/src/components/task/TaskCard.tsx
        TaskMeta.md        ← pwa/src/components/task/TaskMeta.tsx
        TaskStack.md       ← pwa/src/components/task/TaskStack.tsx
      views/
        AllView.md         ← pwa/src/components/views/AllView.tsx
        DetailView.md      ← pwa/src/components/views/DetailView.tsx
        EditView.md        ← pwa/src/components/views/EditView.tsx
        ReviewView.md      ← pwa/src/components/views/ReviewView.tsx
        SuggestView.md     ← pwa/src/components/views/SuggestView.tsx
```
