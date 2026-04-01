# Alongside — Design Document

## Concept

A lightweight task manager built around a conversational workflow. The core loop: open a Claude session, ask what's on your plate, work through tasks with Claude as a thinking partner, check them off. The system has no opinions about your productivity. It just holds state reliably so the conversation doesn't have to. 

---

## Session Philosophy

### The conversation is an exchange

The human in the conversation has **too much context** and needs to talk through and bring structure to their work and plans. The LLM in the conversation doesn't have enough context for the work to be done, because each conversation starts fresh.   Alongside exists to facilitate conversations where this exchange of context and structure happens, and to store the important results of those conversations for use in future sessions.

### Awareness is a win

A session that ends without completing any tasks is not a failed session. Looking at the task list, talking through one stuck thing, deciding to snooze something — these are productive outcomes. The tool has no completion metric. It does not count tasks closed or maintain streaks. A task list that gets consulted regularly, even without completions, is a live and trusted system.

Claude never expresses or implies judgment about:
- How long it has been since the last session
- Whether tasks are overdue
- How many tasks are in a given state

Due dates are surfaced as facts when relevant ("the deadline on this was Tuesday") not as verdicts. The tone is orientation, not audit.

### Re-entry over urgency

The default question at session start is not "what's most urgent?" but "what am I most set up to do?" An urgent but underspecified task is an emotional blocker — it consumes executive function without producing motion. A ready task with a good kickoff note is startable in 30 seconds.

`get_ready_tasks` answers the actual question: what can I begin right now?

Urgency signals (due dates, overdue flags) are available but not the default view. Users who respond well to deadline pressure can set `urgency_visibility: show`; they are not the default case.

### No nagging

Alongside has no notification system and does not intend to acquire one. The tool has no opinions about when you work. It has very good context ready for when you decide to. The absence of nagging is a feature, not a gap.

The re-entry experience when returning after a gap should feel like being handed context, not like being handed a verdict. The default opening after a gap: a brief triage offer ("here's what's here, some of this might be stale — want to do a quick pass?"), not an overdue count.

### `start_session` as context injection

Alongside does not require a Claude Project to function. Behavioral instructions — tone, sort preferences, session philosophy — are returned as part of the `start_session` tool response at the beginning of every session. Claude reads the `instructions` block and operates accordingly.

This means the full Alongside experience is available anywhere Claude tools are available: claude.ai (with or without a Project), ChatGPT with MCP support, any future MCP-compatible client. The state is in D1. The instructions travel with the session, not with the client.

For users who do create a Claude Project, the system prompt can reinforce these defaults at the context level, making them slightly more durable across long sessions. But it is not required.

### Minimally invasive UI

The primary information flow is always the conversation, and the MCP app design should reflect that: single-function and vertically compressed UI, possibly as low-impact as a simple informational banner. Don't return a list of tasks widget with each call, or even a banner: let the model do the talking in most cases. 

---

## Architecture Overview

```
┌─────────────────────────────────────────────┐
│  Claude.ai                                  │
│  ┌─────────────────┐  ┌────────────────┐   │
│  │  Conversation   │  │  MCP App UI    │   │
│  │  (chat)         │  │  (inline HTML) │   │
│  └────────┬────────┘  └───────┬────────┘   │
└───────────┼───────────────────┼────────────┘
            │ MCP / OAuth 2.1   │ postMessage JSON-RPC
            ▼                   ▼
┌─────────────────────────────────────────────┐
│  Cloudflare Worker                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │  mcp.ts  │  │  api.ts  │  │ oauth.ts │  │
│  └──────────┘  └──────────┘  └──────────┘  │
│  ┌──────────┐  ┌──────────┐                 │
│  │ app-ui.ts│  │   db.ts  │                 │
│  └──────────┘  └──────────┘                 │
└────────────────────────┬────────────────────┘
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
- **Claude** talks to the Worker via MCP, authenticated via OAuth 2.1 with PKCE
- **The MCP App UI** renders inline in the Claude.ai conversation via the MCP Apps spec
- **The PWA** talks to the Worker via REST for standalone use outside Claude sessions

---

## Data Model

```sql
CREATE TABLE tasks (
  id            TEXT PRIMARY KEY,   -- nanoid, e.g. "t_x7k2m"
  title         TEXT NOT NULL,
  notes         TEXT,
  status        TEXT NOT NULL       -- 'pending' | 'active' | 'done' | 'snoozed'
                DEFAULT 'pending',
  due_date      TEXT,               -- ISO 8601 date string, nullable
  recurrence    TEXT,               -- iCal RRULE string, nullable
  session_id    TEXT,               -- set when activated in a session
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  snoozed_until TEXT                -- nullable, ISO 8601
);

CREATE TABLE oauth_codes (
  code           TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  expires_at     INTEGER NOT NULL
);
```

Recurrence is handled by the Worker on task completion: if a task has an RRULE, completing it creates a new pending task with the next due date rather than marking it done permanently.

---

## Worker Structure

```
worker/
├── src/
│   ├── index.ts        # entry point, routing, auth check
│   ├── db.ts           # all D1 operations
│   ├── mcp.ts          # MCP protocol handler (JSON-RPC)
│   ├── api.ts          # REST endpoints for PWA
│   ├── oauth.ts        # OAuth 2.1 authorization server
│   ├── app-ui.ts       # MCP App widget HTML (served as ui:// resource)
│   ├── dev-harness.ts  # local test harness at /dev/app
│   ├── ui.ts           # legacy iframe widget at /ui/active
│   └── sign.ts         # HMAC URL signing for legacy widget
├── schema.sql
└── wrangler.toml
```

### MCP Tools (what Claude can call)

| Tool | Visibility | Description |
|------|------------|-------------|
| `list_tasks` | Model + App | Returns tasks filtered by status and/or search query |
| `add_task` | Model + App | Creates a new pending task |
| `complete_task` | App only | Marks done, handles recurrence |
| `snooze_task` | Model + App | Postpones a task until a date |
| `update_task` | Model + App | Edits title, notes, due_date, recurrence |
| `delete_task` | Model + App | Hard-deletes a task |

All tools that mutate state also return an updated task list via the MCP App UI (the `_meta.ui.resourceUri` field triggers an inline widget render in Claude.ai).

### REST Endpoints (what the PWA calls)

```
GET    /api/tasks              list all non-done tasks
GET    /api/tasks/:id          get one task
POST   /api/tasks              create task
PATCH  /api/tasks/:id          update task
DELETE /api/tasks/:id          delete task
POST   /api/tasks/:id/complete complete + handle recurrence
```

---

## Auth

The Worker is an OAuth 2.1 authorization server. Claude.ai's MCP connector performs the full PKCE flow before connecting:

1. Discovers endpoints via `/.well-known/oauth-protected-resource` → `/.well-known/oauth-authorization-server`
2. Registers dynamically at `/oauth/register`
3. User logs in at `/oauth/authorize` with the static `AUTH_TOKEN` as password
4. Code is stored in D1 (not in-memory — Worker isolates don't share state across requests)
5. Token exchange at `/oauth/token` with PKCE verification
6. Issued access token is the static `AUTH_TOKEN` env var

The PWA and direct API access use the same static bearer token directly.

---

## MCP App Widget

The widget is served as a `ui://alongside/task-dashboard` resource per the MCP Apps spec (2026-01-26). Claude.ai renders it inline whenever a tool call includes `_meta.ui.resourceUri`.

### Handshake

The view initiates the handshake (per spec — not the host):

1. Widget sends `ui/initialize` via `postMessage` to the host
2. Host responds with `hostContext` (theme, color scheme)
3. Widget applies CSS variables and `color-scheme`

### Filter sync

The widget tracks the model's active query via `tool-input` / `tool-result` postMessage events:

- When Claude calls `list_tasks` with a query, the widget receives that filter via `tool-input`
- The widget displays a "Filtered: ..." banner and fetches the matching subset
- The filter persists through mutations — it's only cleared if Claude issues a new unfiltered list call

### Checkbox completions

Checking off a task in the widget sends a `tools/call` for `complete_task` back to the host via postMessage RPC. The host executes it against the Worker.

### Local testing

A dev harness at `/dev/app` simulates the MCP Apps host locally: loads the widget in a sandboxed iframe, implements the postMessage protocol, and dispatches tool calls to the real Worker API. Includes a theme toggle and message log.

---

## Session Flow

The intended workflow — loose, not enforced:

1. Open Claude.ai, start conversation
2. Ask what's on your plate; Claude calls `list_tasks`
3. MCP App UI renders inline showing the task list
4. Work happens — conversation, thinking, actual doing
5. Either party checks tasks off; widget updates inline
6. Deferred tasks get snoozed; new ones get added as they come up

The `active` status and session activation still exist but are less central than originally designed — mostly useful for the legacy PWA session flow.

---

## PWA

```
pwa/
├── index.html      # single-file app, all views
├── sw.js           # service worker (cache + background sync)
└── manifest.json
```

### Offline-first sync

1. All writes go to IndexedDB immediately (optimistic)
2. Service worker background-syncs to the Worker when online
3. On foreground, fetch from Worker and merge (last-write-wins on `updated_at`)

### PWA Views

- **Today**: active tasks + tasks due today
- **All tasks**: full list, grouped by status
- **Add/edit task**: title, notes, due date, recurrence picker
- **Session start**: pick tasks to activate

---

## Cloudflare Services Used

| Service | Purpose | Free tier |
|---------|---------|-----------|
| Workers | Compute | 100k req/day |
| D1 | SQLite database | 5GB, 5M reads/day |
| Pages | PWA hosting (optional) | Unlimited |

Total expected cost: **$0/month** for personal use.

---

## What We're Exploring

**Code mode**: an experimental branch adds a `run_code` MCP tool that executes model-generated JavaScript in an isolated V8 context (Cloudflare Dynamic Workers, open beta as of March 2026). The code receives a `tasks` API object with the same surface as the individual tools. The appeal: zero gaps in the toolset — any bulk operation, complex query, or thing-we-didn't-anticipate is expressible. All mutations from a `run_code` call are grouped into a single undo batch via an append-only event log.

------

## Expanded Data Model

The following additions layer onto the existing schema without breaking it. Existing tasks continue to work as-is.

```sql
-- New columns on tasks
ALTER TABLE tasks ADD COLUMN task_type   TEXT NOT NULL DEFAULT 'action';
  -- 'action' | 'plan' | 'recurring'
ALTER TABLE tasks ADD COLUMN project_id  TEXT REFERENCES projects(id);
ALTER TABLE tasks ADD COLUMN kickoff_note TEXT;
  -- re-entry ramp: written for someone with zero context
  -- "open X, look at clause 4.2, that's where the issue is"
  -- not a summary of what happened — instructions for what to do next
ALTER TABLE tasks ADD COLUMN session_log TEXT;
  -- appended at session close: what happened, what was decided
  -- for recurring tasks, the most recent log becomes the next kickoff_note

-- Projects
CREATE TABLE projects (
  id           TEXT PRIMARY KEY,     -- nanoid
  title        TEXT NOT NULL,
  kickoff_note TEXT,                 -- where to start and why
  status       TEXT NOT NULL DEFAULT 'active',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

-- Horizontal dependency graph (not a hierarchy)
CREATE TABLE task_links (
  from_task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  to_task_id   TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  link_type    TEXT NOT NULL,
  -- 'blocks'    : from_task must complete before to_task can start
  -- 'related'   : informational, no scheduling implication
  -- 'supersedes': from_task replaces to_task (to_task effectively archived)
  PRIMARY KEY (from_task_id, to_task_id, link_type)
);

-- User preferences (written conversationally, not via settings UI)
CREATE TABLE user_preferences (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

**Default preference values** (inserted on first `start_session` if absent):

| Key | Default | Effect |
|-----|---------|--------|
| `sort_by` | `readiness` | `readiness` \| `urgency` \| `manual` |
| `planning_prompt` | `auto` | Trigger planning conversation on `plan` tasks |
| `kickoff_nudge` | `always` | Ask for kickoff note if missing on activation |
| `session_log` | `ask_at_end` | `auto_generate` \| `ask_at_end` \| `manual` |
| `interruption_style` | `proactive` | Offer to capture structure mid-conversation |
| `urgency_visibility` | `hide` | Whether due dates surface in suggestions |

Preferences are updated conversationally ("stop showing me due dates") — Claude calls `update_preference` directly. No settings screen needed or intended.

---

## Projects

A project is a named container for related tasks, with a single piece of attached reasoning: a **kickoff note**.

The kickoff note is not a summary. It is a re-entry ramp — written for someone who needs to start working within 30 seconds and has no context from previous sessions. The difference:

- Summary: "We discussed the lease terms and decided to push back on clause 4.2."
- Kickoff note: "Open the Steinberg draft, search for clause 4.2. That's the ambiguous exclusivity language. The goal is to narrow its scope without reopening price."

Kickoff notes live on projects (for overall project re-entry) and on individual tasks (for task-level re-entry). The project-level note answers "where does this start?" The task-level note answers "what do I do first?"

Both are written and updated by Claude during conversation — not manually maintained. The user never needs to open a form to fill them in.

**Projects are lightweight by design.** No members, no status boards, no timeline views. They exist to:
1. Group related tasks so `get_ready_tasks` can surface them together
2. Hold the kickoff note that makes project re-entry fast
3. Give task links a common frame of reference

---

## Task Linking

Alongside uses a **horizontal dependency graph** rather than a subtask hierarchy.

Most task managers model complexity as a tree: a parent task contains children. This creates a meta-task of managing the hierarchy — you have to decide where things live, and the structure becomes load-bearing overhead. Alongside instead uses named links between peer tasks.

Four link types:

| Type | Meaning | Effect on `get_ready_tasks` |
|------|---------|------------------------------|
| `blocks` | This task must complete before the linked task | Linked task hidden until this one is done |
| `related` | Informational connection | None — purely contextual |
| `supersedes` | This task replaces the linked task | Linked task treated as snoozed |

The `blocks` link is the only one with scheduling implications. `get_ready_tasks` returns tasks with no unresolved `blocks` dependencies — tasks that are actually startable right now, not just theoretically pending.

**Capturing links conversationally.** When Claude notices dependency language in conversation ("I need to do X before Y" / "this depends on" / "that unblocks"), it offers to call `link_tasks`. The offer is one sentence with implicit yes/no. Claude does not restructure existing tasks without confirmation, but it asks proactively when the pattern is clear.

---

## New and Updated MCP Tools

### `start_session`

Call at the beginning of any Alongside session. Returns current task context **plus** behavioral instructions for the conversation. This is the mechanism by which Alongside works without requiring a Claude Project — the instructions land in context at the first tool call rather than in a system prompt.

Returns:
- `suggested_tasks`: top 3 ready tasks ranked by readiness score (see below)
- `preferences`: current `user_preferences` values
- `returning_after_gap`: true if last session was >7 days ago
- `instructions`: behavioral directives (tone, sort order, session philosophy)

Claude reads the `instructions` block and operates accordingly for the session. The instructions are not shown to the user.

**Readiness score** (internal, not user-facing): computed per task from:
- Has kickoff note (+3)
- Has session log (+2)
- No unresolved `blocks` dependencies (+3)
- Due date within 7 days (+1)
- Active in a session within last 14 days (+1)

Urgency (due date proximity) contributes one point out of ten. It is a tiebreaker, not the primary signal.

### `create_project`

Creates a project and optionally links existing tasks to it. Claude calls this when conversation surfaces a cluster of related tasks with a natural starting point. Always offers before calling — never silently restructures.

### `link_tasks`

Creates a `task_links` row. Claude calls this when it detects dependency language in conversation. The offer is proactive but the call requires implicit or explicit confirmation.

### `get_ready_tasks`

Returns tasks with no unresolved `blocks` dependencies, sorted by readiness score. The primary answer to "what should I work on?" — replaces the raw `list_tasks` call for session starts.

### `get_project_context`

Returns a project's kickoff note, status, and all its ready tasks in one call. Used at session start when the user references a project by name.

### `update_kickoff_note`

Rewrites the kickoff note on a task or project. Called by Claude at session close, or mid-session when a planning conversation produces a clear starting point. Written prospectively ("next time, start by...") not retrospectively ("this session we...").

### `update_preference`

Writes a key/value pair to `user_preferences`. Called conversationally when the user expresses a preference adjustment. Claude calls this without prompting the user to confirm — the statement of preference is the confirmation.

### Updated `activate_task` behavior

Behavior now varies by `task_type`:

- **`action`**: Normal activation. If `kickoff_note` is empty, Claude asks one orienting question ("where does this one start?") and writes the answer as the kickoff note before proceeding.
- **`plan`**: Does not add to the active checklist. Instead triggers a planning conversation. Output of the conversation is new `action` tasks, links, and a project kickoff note. The plan task completes when a project exists with at least one ready action task.
- **`recurring`**: Activates normally. If a previous session log exists, reads it aloud as context before asking how to start. On completion, copies the session log as the kickoff note for the next recurrence.

---

## Adaptive Behavior

Alongside does not have modes. "Neurotypical mode" would mean sort by urgency, skip planning conversations, don't push for kickoff notes — which is just a worse product. The features that help ADHD users most (readiness sorting, kickoff notes, session logs) are strictly better for everyone. The ADHD framing made the requirements legible; the features are universal.

What varies across users is not neurology but **operational dimensions**:

- **Transition cost**: How expensive is task-switching? High → readiness sorting and kickoff notes are load-bearing.
- **Underspecification tolerance**: How comfortable with fuzzy tasks? Low → planning conversations, automatic structure capture.
- **Urgency responsiveness**: Does deadline pressure help or paralyze? The `urgency_visibility` preference controls this directly.
- **Interruption sensitivity**: Does Claude offering to capture structure mid-conversation help or disrupt? Controlled by `interruption_style`.

These are continuous, not categorical. They also shift with context — hyperfocus raises interruption sensitivity; a bad week raises underspecification intolerance. Preferences are meant to be updated, not set once and forgotten.

---

## First Use: The Brain Dump Session

The onboarding flow is not a tutorial. It is a brain dump — a conversation that asks the user to say what's on their plate, and turns the output into a populated, structured, ready-to-use task system. The product is working during onboarding, not being demonstrated.

The flow:

1. "Tell me what's on your plate right now — work, personal, whatever's taking up space in your head."
2. As the user talks, Claude creates tasks, identifies projects, captures links, asks one clarifying question per fuzzy item.
3. At the end: "Here's what I've got. These two look most ready to start — want to activate one now?"

The session ends with the full loop completed: dump → organize → activate → work. Thirty minutes in, the user has already used Alongside, not just set it up.

**The empty state is an invitation.** When a new user connects Alongside and asks what's on their plate, the response is not a blank list — it is an offer: "Nothing's in here yet. Want to do a brain dump and get set up?"

### Subsequent use: return sessions

The second session is where most productivity tools lose people. Alongside's answer:

1. `start_session` returns suggested tasks with kickoff notes — re-entry is pre-loaded, not reconstructed.
2. Claude does not open with what's overdue. It opens with what's ready.
3. If returning after a gap, Claude offers a quick triage pass before suggesting tasks — "some of this might be stale."
4. The brain dump is available as a recurring tool, not just onboarding. Any time things feel chaotic: "want to do a brain dump and see what's actually on your plate?"

### Preference onboarding

Preferences are not set in a form. They emerge from the early sessions via a light conversation:

- "When you sit down to work, what's usually the hardest part — knowing what to do, or making yourself start?"
- "Does seeing a deadline help you focus, or does it add pressure?"
- "When I notice something worth saving mid-conversation, do you want me to say so right then, or wait until we're done?"

Claude infers initial `user_preferences` values from the answers. No diagnostic language, no categories, no labels. The preferences are revisable at any time, by conversation.

---

## What This Is Not

- A project manager (no subtasks, no assignees, no dependency hierarchies)
- A calendar (due dates are optional soft suggestions)
- A replacement for thinking (the conversation is still where that happens)
- A subtask manager (task_links are peer relationships, not a hierarchy)
- A nag (no notifications, no streaks, no overdue counts)
- A scheduler (readiness is not urgency; the tool has no opinions about when you work)
- A second brain (it holds task state, not knowledge — for knowledge, use the conversation)

The task list is infrastructure for the conversation, not the point of it.
