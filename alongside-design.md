# Alongside — Design Document

## Concept

A lightweight task manager built around a conversational workflow. The core loop: open a Claude session, activate a couple of tasks together, work on them with Claude as a thinking partner, check them off. The system has no opinions about your productivity. It just holds state reliably so the conversation doesn't have to.

---

## Architecture Overview

```
┌─────────────────────────────────────────────┐
│  Claude.ai                                  │
│  ┌─────────────────┐  ┌────────────────┐   │
│  │  Conversation   │  │  MCP App UI    │   │
│  │  (chat)         │  │  (iframe)      │   │
│  └────────┬────────┘  └───────┬────────┘   │
└───────────┼───────────────────┼────────────┘
            │ MCP protocol      │ postMessage
            ▼                   ▼
┌─────────────────────────────────────────────┐
│  Cloudflare Worker                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │  mcp.ts  │  │  api.ts  │  │  ui.ts   │  │
│  └──────────┘  └──────────┘  └──────────┘  │
│               ┌──────────┐                  │
│               │   db.ts  │                  │
│               └────┬─────┘                  │
└────────────────────┼───────────────────────┘
                     │
              ┌──────┴──────┐
              │  D1 (SQLite) │
              └─────────────┘
                     │
              ┌──────┴──────┐
              │     PWA     │
              │ (IndexedDB  │
              │  + sync)    │
              └─────────────┘
```

Three audiences share one backing store:
- **Claude** talks to the Worker via MCP (reads tasks, activates them, marks complete)
- **The MCP App UI** renders inline in the Claude.ai conversation as an iframe widget
- **The PWA** talks to the Worker via REST for standalone use outside Claude sessions

---

## Data Model

```sql
CREATE TABLE tasks (
  id          TEXT PRIMARY KEY,    -- nanoid, e.g. "t_x7k2m"
  title       TEXT NOT NULL,
  notes       TEXT,
  status      TEXT NOT NULL        -- 'pending' | 'active' | 'done' | 'snoozed'
              DEFAULT 'pending',
  due_date    TEXT,                -- ISO 8601 date string, nullable
  recurrence  TEXT,                -- iCal RRULE string, nullable
  session_id  TEXT,                -- set when activated in a session
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  snoozed_until TEXT               -- nullable, ISO 8601
);
```

Recurrence is handled by the Worker on task completion: if a task has an RRULE, completing it creates a new pending task with the next due date rather than deleting the original.

---

## Worker Structure

```
worker/
├── src/
│   ├── index.ts        # entry point, routes requests
│   ├── db.ts           # all D1 operations
│   ├── mcp.ts          # MCP protocol handler
│   ├── api.ts          # REST endpoints for PWA
│   └── ui.ts           # serves the MCP App iframe HTML
├── schema.sql
└── wrangler.toml
```

### MCP Tools (what Claude can call)

| Tool | Description |
|------|-------------|
| `list_tasks` | Returns tasks filtered by status. Default: pending + active |
| `get_active_tasks` | Returns only active tasks for the current session |
| `add_task` | Creates a new pending task |
| `activate_task` | Sets status to active, records session_id |
| `complete_task` | Marks done, handles recurrence |
| `snooze_task` | Sets snoozed status + snoozed_until date |
| `update_task` | Edits title, notes, due_date, recurrence |

### REST Endpoints (what the PWA calls)

```
GET    /api/tasks              list all non-done tasks
GET    /api/tasks/:id          get one task
POST   /api/tasks              create task
PATCH  /api/tasks/:id          update task
DELETE /api/tasks/:id          delete task (hard delete)
POST   /api/tasks/:id/complete complete + handle recurrence
```

### MCP App UI Resource

When Claude calls `get_active_tasks`, the tool response can include a `ui` field containing the URL of the iframe widget (`/ui/active`). Claude.ai renders this inline. The widget:

- Displays active tasks as a checklist
- Sends a `complete_task` call back to the Worker when checked
- Refreshes automatically via polling or a simple EventSource

---

## PWA

```
pwa/
├── index.html      # single file to start, split later if needed
├── sw.js           # service worker
└── manifest.json
```

### Offline-first sync strategy

Same pattern as TimeClock:

1. All writes go to IndexedDB immediately (optimistic)
2. Service worker background-syncs to the Worker when online
3. On foreground, fetch from Worker and merge (last-write-wins on `updated_at`)
4. Conflict UI only needed if you edit the same task on two devices while offline — punting on this for v1

### PWA Views

- **Today**: active tasks + tasks due today
- **All tasks**: full list, grouped by status
- **Add/edit task**: title, notes, due date, recurrence picker
- **Session start**: pick 1–3 tasks to activate (mirrors the Claude session flow)

---

## MCP App Widget (the iframe)

Served from `/ui/active` on the Worker. Self-contained HTML — no framework needed.

```
┌────────────────────────────┐
│  ● Active Tasks            │
│  ─────────────────────     │
│  ☐  Write DSA agenda       │
│  ☐  Review game store lease│
│                            │
│  + add to session          │
└────────────────────────────┘
```

- Minimal styling, inherits nothing from claude.ai
- Checks off via fetch to `/api/tasks/:id/complete`
- Polling every 10s keeps it in sync if Claude completes something via tool call

---

## Session Flow

The intended workflow:

1. Open Claude.ai, start conversation
2. Say something like "let's start a session" or just ask what's active
3. Claude calls `list_tasks`, suggests a working set
4. You confirm or adjust; Claude calls `activate_task` for each
5. MCP App UI renders inline showing the active list
6. Work happens — conversation, thinking, actual doing
7. Either party checks tasks off as they're completed
8. Snoozed or deferred tasks go back to pending

Nothing enforces this flow. It's a convention, not a mechanism.

---

## Cloudflare Services Used

| Service | Purpose | Free tier |
|---------|---------|-----------|
| Workers | Compute | 100k req/day |
| D1 | SQLite database | 5GB, 5M reads/day |
| Pages | PWA hosting (optional) | Unlimited |
| KV | Auth token storage (optional) | 100k reads/day |

Total expected cost: **$0/month** for personal use.

---

## Auth

For v1: a single static bearer token in an environment variable. Set it in wrangler.toml secrets, check it on every request. Not elegant, but it means your tasks aren't public and you can start building immediately.

For v2 if needed: Cloudflare Access in front of the Worker (zero-config SSO via your Google account, free for personal use).

---

## Build Order

1. **`schema.sql` + `db.ts`** — get the data layer working first, test with wrangler D1 locally
2. **`api.ts`** — REST endpoints, test with curl
3. **PWA** — basic list + add + complete, offline sync
4. **`mcp.ts`** — MCP protocol layer, test with MCP inspector
5. **`ui.ts`** — the iframe widget, test standalone before wiring to MCP Apps
6. **MCP App integration** — add `ui` field to tool responses, test in Claude.ai

Each step is independently testable. You don't need the MCP layer to use the PWA, and you don't need the widget to use the MCP tools.

---

## What This Is Not

- A project manager (no subtasks, no assignees, no dependencies)
- A calendar (due dates are optional soft suggestions)
- A replacement for thinking (the conversation is still where that happens)

The task list is infrastructure for the conversation, not the point of it.
