# Alongside: power-user task model and LLM tools

Status: proposed implementation plan; no application changes implemented by this document.
Written: 2026-09-30. Scope: shared types, persistence, domain operations, REST,
MCP, background execution, and client data compatibility. UI redesign is deferred.

## 1. Product direction and authority

Alongside should let an LLM turn intentions into a durable, inspectable plan:
capture work, decompose it, identify prerequisites, respect deadlines, reserve
time, send reminders, and revise the plan when circumstances change. The user
should be able to say “get this finished by Friday; find two afternoons for it;
remind me before I need to start” and have the resulting objects retain those
distinct meanings.

Natural-language interpretation belongs to the calling LLM. Alongside supplies
precise operations, constraints, queries, explanations, and reliable execution.
It does not require a hosted model or a continuously running chat to maintain
recurrence or deliver notifications. REST and MCP use the same domain operations.

This plan replaces the earlier restrictions against subtasks, calendars,
notifications, and scheduling in `alongside-design.md`. It also supersedes
conflicting **unimplemented** duties decisions: universal instant-only dates,
no occurrence ledger, orphaning stale instances, and generation only when an
occurrence becomes due. Existing migrations and landed recurrence primitives
remain the baseline. The duties plan is background and reusable implementation
material, not a prerequisite checklist to finish unchanged.

Read [the implementation checklist](power-user-todo-implementation-todo.md)
after this document. This document owns semantics and invariants; the checklist
owns sequencing and progress. Update semantics here before changing work orders.
Current API/reference docs continue to describe shipped behavior until each
slice lands. Future sessions must verify the checkout and deployment before
treating any proposed feature as available.

### Target capabilities

| Capability | Durable representation and behavior |
| --- | --- |
| Deadlines | Hard completion boundaries distinct from desired target dates |
| Start/availability dates | Earliest permitted start, independent of visibility deferral |
| Timed reminders | Multiple absolute or relative reminders, snooze, acknowledgment, real delivery |
| Timeblocks | Multiple work reservations per task, fixed or movable; standalone busy time |
| Subtasks | Ordered, nested tasks with their own status, dates, reminders, and dependencies |
| Dependencies | Acyclic prerequisites, explicit blocker explanations, cancellation policy |
| Recurrence | Calendar and completion-relative cadence, exceptions, graph templates, occurrence history |
| Organization | Projects, tags/contexts, priority, estimates, waiting state, saved queries |
| Planning | Agenda, free-time search, feasibility diagnostics, inspectable bulk changes |
| Continuity | Kickoff notes, session history, work logs, mutation provenance, reversible batches |
| Reliability | Idempotent commands, optimistic concurrency, deletion tombstones, versioned export/import |

Single-user scope remains appropriate. Teams, roles, assignees, billing, general
automation scripting, two-way external calendar sync, attachments, and UI
redesign are outside this plan. Preserve extension points without implementing
those systems speculatively.

## 2. Checkout baseline and problems to address

Source inspection on 2026-09-30, rather than the older design doc, establishes:

- `shared/schema.ts` has tasks, projects, links, duties, preferences, action
  logs, and OAuth codes. Tasks have `pending|done`, `action|plan`, UTC `due_date`
  plus nullable `due_all_day`, deferral, focus expiry, and duty identity columns.
- `shared/types.ts` exports raw Drizzle row shapes and loose create/update picks.
  Branded parsers and richer domain unions exist separately in `shared/parse/`,
  `shared/wire/rows.ts`, and `worker/src/domain/`. Extend this architecture;
  raw storage rows must not become the new domain contract.
- Duties schema migration 007, all-day marker migration 008, and the parallel
  `SeriesRrule` parser/calendar engine have landed. The duties checklist marks
  Stages 1–2 done; domain ops, triggering, graph templates, and public duty tools
  have not landed in this checkout. `worker/wrangler.toml` has no cron trigger.
- Completion still creates the next legacy recurring task. New features must
  not accidentally enable both completion spawning and calendar materialization.
- Links already support `blocks|related` and reject dependency cycles. There is
  no hierarchy, effort model, notification queue, time reservation, or delivery
  channel model.
- `worker/src/storage/apply.ts` has pure plans, SQL guards, and D1 batches. It
  chunks sufficiently large unguarded plans into separate batches. That cannot
  provide atomicity for a large task graph or replacement import.
- PWA sync uses local writes and a pending-op queue, then pulls snapshots.
  Create operations rebind temporary IDs to server IDs. Rich graphs need stable
  IDs and conflict handling beyond timestamps. `pwa/src/api/result.ts` already
  treats auth/rate-limit errors as retryable, but currently treats 409 as durable.

The central semantic flaw is overloading a date with “aim for”, “must finish by”,
“start then”, and “notify then”. A deadline does not schedule work or create a
notification. A reservation does not make a task complete. Focus expiry is
attention metadata, not a calendar interval. Deferral hides a task, while an
availability boundary constrains when work is allowed to start.

Noon UTC plus an all-day boolean is also insufficient as a general date model:
it obscures the intended calendar date and cannot preserve it across every
viewer timezone. Last-write-wins and mutable text logs are similarly inadequate
for concurrent scheduling and reliable history.

## 3. Temporal types and resolution

Preserve calendar dates as dates; preserve actual instants as instants. Add
separate branded types instead of continuing to reuse `IsoDateTime` for both
minute scheduling and full-resolution event history.

```ts
// Names are proposed; all brands require runtime parsers.
type TemporalPoint =
  | { kind: 'date'; date: LocalDate; timezone: Timezone }
  | { kind: 'instant'; at: MinuteInstant; timezone: Timezone };

type TaskDateRole = 'available_from' | 'target' | 'deadline';
type TaskDate = { taskId: TaskId; role: TaskDateRole; point: TemporalPoint };

type TimeInterval = { start: MinuteInstant; end: MinuteInstant };
// Half-open [start, end), with end > start.
// EventInstant retains seconds/milliseconds for audit and work logs.
```

Implementation note (2026-10-05, slice 3a): `target` is the legacy `due_date`/`due_all_day`
pair; `available_from` and `deadline` are stored as canonical `TemporalPoint` JSON in two columns of
`tasks`, not a `task_dates` table. The semantics here are unchanged.


`MinuteInstant` normalizes offset-bearing input to canonical UTC and truncates
sub-minute input, preserving the existing scheduling precision contract.
`LocalDate` strictly validates real `YYYY-MM-DD` dates. `Timezone` uses the
existing validated IANA-zone approach. Wire inputs distinguish these variants;
reject a bare local datetime with no timezone/offset. Human phrasing such as
“tomorrow morning” must be resolved by the LLM or an explicit resolver call.

Add a typed workspace default timezone and named working hours. The default is
used when **creating** a zoned value; it never silently reinterprets existing
values. Travel changes the display/planning zone unless the user explicitly
reschedules floating intentions. Store the timezone on temporal objects so
“Friday in Los Angeles” stays meaningful in another viewer zone.

Date boundaries resolve as follows:

- A date-only availability boundary opens at the start of that local date.
- A date-only target/deadline permits completion throughout that local date;
  its exclusive boundary is the start of the following local date. Do not use
  “23:59:59”, UTC noon, or an assumed 24-hour day.
- A timed deadline is met when `completed_at <= deadline.at`; a date deadline
  is met when completion is strictly before its exclusive boundary.
- Relative reminders against date values require a local anchor time, such as
  09:00 on the specified date. They never silently fire at midnight or at the
  exclusive next-day boundary.
- For nonexistent/repeated midnight boundaries, select the first valid instant
  of the date/earliest matching instant. A wholly skipped local date is a
  validation error for a date boundary. Cover this in timezone tests.

Provide a side-effect-free `resolve_time` tool accepting structured local
date/time, zone, and DST disambiguation. One-off nonexistent wall times return
an error and suggested alternatives; folds require an explicit earlier/later
choice when ambiguous. Calendar recurrence keeps the landed policy of skipping
spring gaps and choosing the earlier fall-fold instant; return that policy in
series previews. Relative **elapsed-minute** offsets use instant arithmetic;
relative **calendar-day** offsets use zoned date arithmetic. These are distinct
typed offset variants.

Queries receive an explicit `now` from the server and return the interpreted
zone and interval. “Today” uses zoned calendar boundaries, not the next 24 hours.
Derived UTC boundaries may be indexed/cached alongside canonical values, but
canonical date/zone data wins; cache rebuild must not alter intent.

## 4. Core tasks, hierarchy, and readiness

Retain tasks as the unit of work, projects as containers, and links as horizontal
relationships. Add hierarchy directly to tasks; do not encode parenthood using
`blocks`, project membership, or an embedded JSON checklist.

```ts
type TaskStatus = 'pending' | 'in_progress' | 'waiting' | 'done' | 'cancelled';
type NodeRole = 'action' | 'group' | 'milestone';
type Priority = 'none' | 'low' | 'normal' | 'high' | 'urgent';
type CompletionPolicy = 'manual' | 'all_children_done';

interface TaskExtensions {
  parentId: TaskId | null;
  position: SortKey;
  nodeRole: NodeRole;
  completionPolicy: CompletionPolicy;
  priority: Priority;
  estimateMinutes: PositiveMinutes | null;
  minimumBlockMinutes: PositiveMinutes | null;
  splittable: boolean;
  waitingReason: BoundedString<2000> | null;
  completedAt: EventInstant | null;
  cancelledAt: EventInstant | null;
  revision: Revision;
  deletedAt: EventInstant | null;
}
```

Keep `task_type: action|plan`: it describes how the conversation approaches the
task, while `node_role` describes structure. A planning task can still be a real
action with an estimate. A group is a container with no independently scheduled
work. A milestone has zero work duration and can be completed after its
prerequisites; it can carry a deadline and reminders. Reject estimates and work
blocks on groups/milestones. Breaking a task into children is an explicit
conversion to a group; preserve the original notes, links, and dates. Existing
blocks require an explicit move/cancel choice in that conversion.

Hierarchy rules:

1. One parent per task, arbitrary bounded nesting, no self-parent or cycle.
   Only groups may have children. Use an initial maximum depth of 32 and return
   a structured limit error; do not let recursive operations run unbounded.
2. Descendants share their root's project, including null. Moving a subtree to
   another project updates it atomically and checks links/active reservations;
   it never silently detaches children. Cross-project dependencies are allowed.
3. `position` orders siblings and top-level project tasks. Use a validated
   fractional sort key with stable ID tie-breaks and explicit bounded rebalance.
4. Groups default to manual completion. `all_children_done` is opt-in, requires
   at least one live child, and completes only when all live children are done.
   A cancelled child remains unresolved for this policy; resolve it explicitly
   by removing it from the group or changing the group's policy. Removing the
   last child does not auto-complete an empty group.
5. Completing a manual group requires its children done. An explicit cascade
   command may complete the subtree after a preview enumerates the scope.
   Cancelling a group cancels its live descendants atomically. Reopening a
   child reopens completed ancestors that use `all_children_done`; reject
   reopening under another terminal ancestor until that ancestor is reopened.
6. Deletion defaults to soft deletion. Deleting a group must specify subtree
   deletion or promotion of its children; the ordinary single-task delete
   rejects groups with live children. Purge is a separate maintenance action.

Availability, deferral, waiting, dependency state, and attention remain separate.
Keep the existing `DeferState` union and focus metadata. `waiting` requires a
reason and may have a follow-up reminder; it does not auto-complete or auto-open
when the reminder fires. Terminal tasks clear active focus/deferral, stop timers,
cancel future task reminders, and release future work reservations in the same
mutation. Preserve historical reservations and logs. Reopening never resends
old reminders; explicitly rearm or create a new reminder generation.

### Dependencies and effective constraints

Keep `from -> to` meaning “from must be done before to starts”. `related` links
remain informational and should canonicalize their endpoint order to avoid
duplicate reversed links. A cancelled/deleted blocker is **not** completed:
report an unresolved prerequisite until the user removes/replaces the edge or
explicitly waives it. Do not unblock dependent work merely by deleting it.

Parenthood does not implicitly sequence siblings. Group prerequisites apply to
its descendants. A group is complete only under its completion policy, so a
downstream task blocked by a group waits for the group's resolution. Reject
dependency links between ancestors and descendants. Also reject cycles in the
effective graph after inherited group prerequisites and child-to-group
completion requirements are expanded. A tree check and a peer-edge check alone
are insufficient. Validation must run against the final proposed graph and be
guarded against concurrent structural changes at commit.

Effective deadlines are the earliest applicable task/ancestor hard boundary;
effective availability is the latest applicable task/ancestor opening boundary.
Return the source task IDs for every inherited constraint. Parent targets do
not become hard deadlines. A child's own deadline later than its parent's is
retained as entered but yields an explicit ineffective/conflicting-date warning.
An empty effective work window is infeasible; it does not corrupt the task.

`get_ready_tasks` returns pending/in-progress action or milestone tasks with
open availability, no active deferral, no unresolved prerequisite, and no
terminal ancestor or archived project. Return reason codes, not just a score.
Groups return in context/progress queries, not the actionable queue. Scheduling
a prerequisite before dependent work is allowed as a planning assumption;
runtime readiness still waits for actual completion.

Priority and urgency influence ranking, never override readiness gates.
Estimates represent total expected effort; remaining effort defaults to
`max(estimate - logged work, 0)` with an optional explicit remaining estimate.
Time elapsed in a block is not logged work. Group effort/progress aggregate
leaves without counting group estimates or repeatedly counting descendants.

## 5. Timeblocks and planning constraints

Add `time_blocks` as first-class intervals:

```ts
type TimeBlock = CommonEntity & {
  id: TimeBlockId;
  owner: { kind: 'task'; taskId: TaskId } | { kind: 'busy'; title: NonEmptyString<200> };
  interval: TimeInterval;
  timezone: Timezone;
  placement: 'fixed' | 'movable';
  status: 'scheduled' | 'completed' | 'cancelled' | 'missed';
  notes: BoundedString<2000> | null;
};
```

A task may have several blocks; a block belongs to one task or standalone busy
time. A task's target/deadline remains unchanged when its blocks move. Marking a
block complete/missed does not complete the task. Past scheduled blocks are
reported as elapsed/unreviewed; only explicit user action marks them missed or
completed. Actual work lives in `work_logs`, optionally referencing a block.

Active intervals use `[start,end)` so adjacent blocks do not overlap. Fixed
blocks are immovable by ordinary replanning. Reject active overlaps by default;
an explicit override with a reason can save them and returns a persistent
conflict warning. Rescheduling must validate the **resulting** agenda, not each
intermediate move; swaps should work. Calendar imports can eventually become
standalone busy blocks with source IDs, but no connector is required here.

Store typed working-hours rules in an IANA zone (weekday, local start/end), date
overrides for days off or exceptional availability, and optional transition
buffer minutes. Split overnight working windows at local midnight. These rules
constrain automated placement; an explicit manual block outside them returns a
warning and requires an override flag. Hard deadlines, effective availability,
and unresolved runtime blockers are returned in diagnostics even when a manual
override places the block. Overrides do not erase the underlying constraints.

Provide deterministic primitives before any automatic optimizer:

- `get_agenda(range, timezone)` merges blocks, dates, reminder times, and
  recurrence occurrences, identifying their different roles.
- `find_free_time(range, duration, timezone, constraints)` subtracts active
  blocks and buffers from working windows and returns ranked candidate slots.
- `preview_schedule(task_ids, range, constraints)` respects fixed blocks,
  estimates, minimum chunks, split policy, availability, deadlines, and
  dependency order; movable blocks can move only within the requested scope.
- Return partial feasible proposals and explicit unscheduled tasks/reasons when
  work exceeds capacity. Missing estimates remain unknown; do not invent them.
  Distinguish “insufficient capacity under these assumptions” from a proof that
  no possible schedule exists. Optimization is a later replaceable strategy.

The LLM can choose slots and submit normal typed mutations. A first scheduler
can greedily place prerequisites then tasks by deadline/priority with stable
tie-breaks. Explain each choice and every assumed prerequisite completion. No
autonomous rearrangement happens merely because a new task was added.

## 6. Reminders, notification delivery, and snooze

Add reminders independent of deadlines and blocks. Support standalone reminders
without manufacturing dummy tasks, plus multiple reminders per task/block.

```ts
type ReminderOwner =
  | { kind: 'standalone' }
  | { kind: 'task'; taskId: TaskId }
  | { kind: 'block'; blockId: TimeBlockId };
type RelativeOffset =
  | { kind: 'elapsed_minutes'; minutes: SignedMinutes }
  | { kind: 'calendar_days'; days: SignedDays; localTime: LocalTime };
type ReminderTrigger =
  | { kind: 'absolute'; at: MinuteInstant }
  | { kind: 'task_date'; role: TaskDateRole; offset: RelativeOffset; dateAnchorTime: LocalTime | null }
  | { kind: 'block_boundary'; edge: 'start' | 'end'; offsetMinutes: SignedMinutes };
type ReminderState = 'active' | 'paused' | 'acknowledged' | 'cancelled';
```

The owner/trigger union rejects impossible pairs; relative task triggers require
a task owner and existing named date, and block triggers require a block owner.
For elapsed-minute offsets from a date, `dateAnchorTime` is required; for
calendar-day offsets, `localTime` supplies the anchor and `dateAnchorTime` must
be null. Timed elapsed offsets need no date anchor. Reject contradictory inputs.
Store title/message, trigger, intended channels, state, revision, generation,
resolved `fire_at`, optional `snoozed_until`, late-delivery policy, and audit
timestamps. Resolve against the owner's **effective** date and return that
source, including inherited group dates. Recompute when any contributing date
or block changes. Default expiry is 24 hours after the resolved fire time;
allow an explicit alternative. Expired notifications stay visible in the inbox
as missed and do not produce a burst of stale push messages after an outage.

Rules:

- Setting a deadline/target creates no reminder unless requested. A reusable
  reminder preset can supply explicit defaults when a task is created.
- Removing the referenced date pauses the reminder with `missing_anchor`.
  Restoring the date does not silently rearm it; explicit resume is required.
- Moving an anchor increments generation and cancels old unsent deliveries.
  An acknowledged reminder remains acknowledged across ordinary edits.
- Snooze is a one-off delivery override for the current generation. Repeated
  snooze replaces that override. Acknowledgment ends it; snooze never changes
  the task deadline or its recurrence. Anchor changes clear the snooze and
  return that effect in the mutation summary.
- Creating/rearming a reminder in the past requires explicit `past_due` policy
  `send_now|inbox_only|skip`; reject omission instead of silently discarding it.
- Repeating nag reminders are optional explicit bounded policies, not implicit
  overdue behavior. They require an interval, stop condition, and maximum sends.
  Calendar-repeating standalone reminders use the same recurrence engine as
  duties, with a reminder template rather than a task template.

### Background execution

Persist notification intent transactionally with task/reminder mutations. A
background dispatcher scans indexed due deliveries, claims a bounded batch with
a lease token/expiry, sends outside the database transaction, and records each
attempt. Concurrent runners and expired leases are normal operating conditions.

Use a one-minute Worker cron as the initial wake-up mechanism, with a shared
bounded `runDueWork(now)` used by cron and recovery/admin calls. The scan uses
`next_attempt_at <= now`, not equality with a tick. This is a chosen practical
cadence, not an exact-time promise. Cloudflare documents UTC cron and an
every-minute expression; reminder timezone arithmetic belongs in the domain
model. See [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/).

Use delivery rows keyed uniquely by `(reminder_id, generation, channel_id,
send_index)`, with pending/leased/accepted/failed/cancelled/missed state,
scheduled time, next attempt, lease token, attempt count, and last error.
Attempt history is append-only. Check reminder generation, owner terminal
state, channel state, and lease ownership immediately before dispatch. Updating
after send must be fenced by lease token. A paused/cancelled item never gets
claimed anew. Retry network/5xx/429 with capped exponential backoff and jitter;
disable expired subscriptions and surface permanent failures. Initial limit:
8 attempts and no retry beyond the reminder's expiry.

External sending cannot be committed atomically with D1. A provider can accept
a send just before the worker crashes, so retry can duplicate it. Promise
durable intent and at-least-once attempts, with stable notification IDs for
provider/client deduplication. `accepted` means provider acceptance, not proof
that the user saw it. Track explicit acknowledgment separately. Cancellation
can race with an already in-flight send; report that state honestly.

Default channels: durable inbox plus Web Push. Inbox makes history queryable
through MCP, but inbox-only is not sufficient to claim closed-app notification
support. Web Push requires a registered subscription, service-worker handler,
and user permission. MDN documents server push with the app unloaded and the
service-worker/subscription requirement; see [Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API).
Implement only minimal enrollment/test-delivery plumbing when needed, keeping
the visual redesign deferred. A Worker-compatible Web Push adapter and VAPID
secrets must be verified before claiming delivery works. Add an authenticated
webhook adapter later if useful; do not assume an MCP tool response can wake a
closed chat. Do not implement email/SMS providers in the first release.

Quiet hours are typed zoned intervals, disabled by default. When enabled,
postpone ordinary delivery until the next permitted time, still respecting
expiry; a per-reminder explicit bypass is available. Store original scheduled
time separately from delivery time. Tests use a fake adapter; release acceptance
requires one real opted-in device with the app closed.

## 7. Recurrence: retain duties, add occurrence identity

Keep `duties` as the persistent recurring-definition table and existing IDs.
Public tools may describe these as recurring series while retaining duty aliases.
Reuse the landed timed `SeriesRrule` profile, cap, deterministic zoned expansion,
and immutable calendar anchor. Add validated date-anchored and completion-based
schedule variants rather than forcing them into timed RRULE strings:

```ts
type SeriesSchedule =
  | { kind: 'calendar_timed'; dtstart: MinuteInstant; timezone: Timezone; rrule: SeriesRrule }
  | { kind: 'calendar_date'; startDate: LocalDate; timezone: Timezone; rrule: DateSeriesRrule }
  | { kind: 'after_completion'; first: TemporalPoint; interval: CompletionInterval; timezone: Timezone };
type CompletionInterval =
  | { kind: 'elapsed_minutes'; amount: PositiveMinutes }
  | { kind: 'calendar_days'; amount: PositiveDays; localTime: LocalTime };
type CatchUpPolicy = 'all' | 'latest' | 'skip';
```

The date profile permits date-level frequencies/filters and finite COUNT/UNTIL
with a date bound, rejecting hour/minute fields. It is a separate parser with
tests, not a silent relaxation of `SeriesRrule`. Sub-second recurrence remains
out of scope. Monthly/yearly completion intervals can be added later with an
explicit end-of-month policy; fixed day/minute intervals ship first.

Series definitions own versioned templates of task nodes, hierarchy, links,
relative task dates, and reminder rules. Instantiate a complete occurrence
graph atomically, including its internal identities. Absolute one-off task
dates are not silently copied into every occurrence. Validate template-relative
offsets, parent/dependency cycles, and size before saving. Single-task templates
are the degenerate initial case; retain a shape that can expand to graphs.
Templates have a versioned discriminant `task_graph|standalone_reminder`;
standalone reminder series materialize reminder occurrences without dummy tasks.

Add `series_occurrences` keyed by `(duty_id, occurrence_key)`. Its canonical
identity is the original scheduled instant/date (or predecessor completion for
completion-based series), never an edited task deadline or rescheduled block.
Store planned, materialized, skipped, or cancelled state, scheduled point,
template version, optional overridden point, and timestamps. Associate generated
tasks through occurrence ID and template node key, unique together. Existing
`duty_id/occurrence_at` stay compatibility projections during migration; the
two-column task unique index is replaced before graph instances are enabled.

The ledger prevents deleted/cancelled/skipped occurrences from reappearing and
provides the foundation for single-occurrence exceptions. It is distinct from
delivery receipts and from the action log. A cached generation cursor and next
candidate can speed scans; they are not the sole history of what happened.

Calendar generation is independent of completion. Completion-based cadence has
at most one current unresolved occurrence; completing its root produces the
next occurrence once, keyed by predecessor occurrence ID. Reopening never
creates another next occurrence or deletes work already generated. Cancellation
requires explicit `end_series|skip_and_continue` handling for this cadence;
it is not a hidden completion event.
Persist the current occurrence pointer on the duty. Reopened older occurrences
are historical backlog and cannot advance that pointer or generate successors.
`first` supplies the initial scheduled point; its zone must match the series.
An explicit skip-and-continue uses the recorded skip event as its interval base
and returns that resolution; it is not inferred from ordinary cancellation.

Generate calendar occurrences ahead of time so planning and early reminders
can see them. Default automatic horizon is 30 local calendar days, expandable
by explicit agenda/planning requests. Negative template date/reminder offsets
extend lookahead far enough to include events in that horizon. Bound each run
by occurrence count, template size, SQL statements, and elapsed runtime; report
coverage and continuation when capped. High-frequency series must not allocate
an entire month's instances eagerly. Reuse the existing 10,000 expansion cap
as a safety ceiling, with much smaller materialization batches.

Separate future generation from catch-up of missed historical occurrences:
`all` creates bounded backlog, `latest` materializes the newest missed occurrence,
and `skip` records skipped range coverage and advances. None detaches already
materialized unfinished tasks from their series. Preserve provenance and show
backlog explicitly. Represent huge skipped spans as bounded range records so
minute recurrence cannot require millions of per-occurrence writes. Never mark
an occurrence skipped if it already has generated tasks.

Exception operations:

- “This occurrence”: record an override/skip keyed by original occurrence
  identity; mutate generated objects explicitly when already materialized.
- “Future template”: create a new template version and an effective occurrence
  boundary. Existing generated work changes only with explicit propagation
  and preview of modified/untouched instances.
- “This and following cadence”: end the old anchor at an explicit boundary and
  create a replacement series with lineage. Handle pre-generated future work
  through an enumerated migrate/cancel/keep choice. Do not rewrite historical
  occurrence identity.
- Pausing halts generation and unsent series reminders, preserving tasks/history.
  Resume applies the chosen catch-up and expired-reminder policy. Ending stops
  new generation; existing tasks and their one-off reminders continue unless
  an explicit cancel-future operation includes them. Archive definitions instead
  of deleting provenance; purge requires a separate retention decision.

Legacy completion recurrence must be retired only in the same release that
backfills series/occurrences and enables the replacement engine. Its existing
RRULE advances from the previous due date, not from actual completion; do not
silently convert it to an after-completion interval. Reconstruct/report an
equivalent calendar anchor where recoverable, and explicitly report the change
to independent calendar generation. Ambiguous/unsupported legacy records stay
on a per-record compatibility path until resolved, with one spawner per record.
Do not infer a hard deadline from legacy recurrence's due date.

## 8. Storage, types, and domain operation boundaries

`shared/schema.ts` remains the schema of record. Extend relational tables rather
than putting queryable scheduling state into notes or arbitrary JSON metadata.
Use strict tagged JSON only for versioned templates, saved query ASTs, command
receipts, and audit diffs, with parser/version contracts.

| Table | Main additions / responsibilities |
| --- | --- |
| `tasks` | Hierarchy/order, node role, lifecycle timestamps, priority, estimates/remaining effort/chunking, waiting reason, revision, soft deletion, occurrence/node identity |
| `task_dates` | One row per `(task_id, role)`; discriminant, local date or UTC instant, zone, optional derived boundary cache, migration provenance |
| `projects` | Revision, soft deletion; preserve kickoff/notes and active/archive behavior |
| `task_links` | Stable relationship identity/revision/tombstone; canonical related endpoints, preserved blocker references |
| `tags`, `task_tags` | Named normalized tags and queryable membership with revision/tombstone semantics |
| `time_blocks` | Task or busy owner, interval, zone, placement/state, explicit override reason, revision |
| `reminders`, `reminder_channels` | Owner/trigger union columns, message, channel membership, state/generation, resolved time, snooze, expiry policy, revision |
| `notification_channels` | Inbox/Push adapter configuration and enabled state; sensitive material separated from ordinary exports |
| `notification_deliveries`, `delivery_attempts` | Unique send identity, leases, due/retry index, acceptance/error history |
| `duties`, `series_templates` | Schedule variant, status/catch-up, immutable anchor, versioned graph/reminder template, current completion occurrence, lookahead cache |
| `series_occurrences`, `series_skip_ranges` | Durable occurrence/node identity, exceptions, bounded skipped historical coverage |
| `task_entries`, `work_logs` | Append-only session/progress notes; actual work intervals and optional running timer |
| `saved_queries`, `planning_settings` | Validated query ASTs; working hours, exceptions, timezone, buffers, quiet hours |
| `command_receipts`, `change_feed`, `workspace_meta` | Idempotency results, sync cursor/tombstones, aggregate structural/calendar revision |
| `action_log` | Command batch ID, actor/source, affected entity IDs, before/after changes, causal links |

Every user-mutable entity/relation gets a monotonic revision. Join records may
use stable composite identities, but still need revisions and deletions in the
change feed. Internal delivery rows use lease/generation guards instead of
exposing general user mutation APIs. Retain legacy `session_log` as a projection
or migrated entry; do not silently split old prose into invented sessions.
Running timers use server event instants, at most one live timer per workspace,
with explicit reconciliation of offline starts and stop-time corrections.
Legacy done tasks may lack a recoverable completion time. Retain that unknown
with migration provenance; never substitute `updated_at` as a claimed exact
completion. New completion/cancellation commands record their event instant.

Flatten unions to constrained SQL columns: exactly one of date/instant, exactly
one permitted owner shape, paired occurrence identity, positive intervals and
durations, valid status/timestamp combinations. Add foreign keys, CHECKs,
uniqueness constraints, and targeted indexes for parent/project/status,
block interval lookup, task-date boundaries, reminder resolved time, delivery
next attempt, occurrence identity, and change-feed sequence. Application
validation handles graph/DST invariants SQL cannot express. Check `EXPLAIN QUERY
PLAN` on representative fixtures rather than adding indexes by reflex.

Separate three layers explicitly:

1. Raw Drizzle storage rows, including compatibility columns.
2. Parsed branded domain unions, independent of nullable storage layouts.
3. Versioned wire inputs/results with strict unknown-key rejection on mutations.

Do not keep growing `Partial<Pick<Task,...>>` as the public mutation model.
Expose commands such as set date, move subtree, complete, snooze, and reschedule
with complete valid input shapes. Omission means leave unchanged; explicit null
means remove where supported. Transition-managed fields, occurrence identity,
revisions, and lifecycle timestamps are never arbitrary patchable fields.

Add brands/parsers in `shared/parse/`, shared row schemas in `shared/wire/`,
domain types/planners in `worker/src/domain/`, codecs and exhaustive apply ops
in `worker/src/storage/`. Runtime reference resolution, domain planning, and
atomic apply remain separate. Each new API/IDB/form/pending-op boundary needs
a parser and meaningful tests. Schema enum hints alone do not enforce SQL
CHECKs, and a row shape passing Valibot is not sufficient graph validation.

## 9. Mutation reliability, sync, history, and import

### Typed batches and optimistic concurrency

Extend the existing `Plan` with command identity, expected revisions, affected
entities, derived side effects, warnings, and inverse data. A semantic command
can generate several storage ops; all invariants apply to the final state.

`preview_changes(commands)` returns a normalized diff, created client-ref/ID
map, effective date resolutions, blockers, overlaps, notification effects,
assumptions, and expected revisions. It is side-effect-free and can be used for
review or LLM planning. `apply_changes` accepts the same commands and expected
revisions or a stored preview token. It must revalidate atomically; a preview
is not a lock. Simple explicitly authorized commands may apply directly and
return the same explanation. Avoid an extra confirmation ceremony for every
ordinary write.

Clients mint valid stable IDs, including offline graph IDs. A command batch can
also use scoped client refs resolved to IDs before apply. Every mutation carries
a caller command ID; `command_receipts` stores a hash of canonical payload and
result. Same ID/same payload returns the original result; same ID/different
payload is a conflict. Receipt, mutations, change feed, audit, and notification
intent commit together. Receipt uniqueness handles a concurrent replay; after
a collision reread the committed receipt rather than executing again.

Use expected entity revisions for ordinary changes and a workspace structural/
calendar revision guard for graph and reservation plans. This guard prevents
phantom blockers or overlaps from insertions absent from the preview. Every
writer of these structures, including background generation/import, advances
the relevant aggregate revision. Assert versions in SQL inside the same batch;
pre-read checks alone cannot prevent races. A failed guard aborts the entire
logical command. Return conflict details with current values; never silently
overwrite scheduling or hierarchy changes by comparing wall-clock timestamps.

D1 `batch()` is transactional for the statements inside that call, according to
[the D1 database API](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch).
This does not make separately chunked batches atomic. Count generated SQL
statements, including guards/logs/receipts, before accepting an atomic command.
Use the current 100-statement app budget as an initial conservative bound;
verify platform/bind limits at implementation time. Reject oversized atomic
graphs with an exact capacity error instead of partially applying them. Larger
imports need staging/generation switching or a separately designed resumable
protocol before they can be called safe; naive wipe-then-chunk is unacceptable.

Audit retains actor (`user|llm|system|import`), command ID, entity IDs, explicit
reason and assumptions, and previous/new values. A batch can be undone only
when current revisions still match its outputs; otherwise return an undo
conflict/preview. Undo does not unsend a push message or pretend to reverse
external effects. Soft deletion and inverse updates are compensating commands,
not historical rewrites. Keep command receipts long enough for replay safety;
initially do not expire them automatically.

### Local-first sync without silent loss

Preserve local-first writes. Add a versioned sync endpoint that returns all
entity families, deletions, and a monotonic cursor; `updated_at` stays display
metadata. Bootstrap must return a consistent snapshot and cursor. A delta pull
has a fixed upper watermark across pages so mid-pull writes appear on the next
pull. An expired cursor triggers an explicit full reset/rebase workflow.

IDB stores canonical server rows plus a pending optimistic overlay. New pending
commands include stable IDs, command ID, schema version, and base revisions.
On 409, preserve the user's intended change as a conflicted command, fetch
current rows, and offer an inspectable rebase through API/MCP. It must not flow
through the current durable-failure path that drops the operation. Semantic
rejections become retained failed intent with diagnostics; auth/429/network/5xx
remain retryable. Preserve ordering and atomic graph batches.

Offline reminders are locally pending until the server accepts their intent;
show this in returned data/status. The server alone materializes series and
dispatches authoritative notifications. Local browser timers cannot promise
closed-app delivery. While disconnected, reservation overlaps and global graph
checks are provisional; reconcile on sync without losing the proposed work.

No redesigned views are required, but client parsers, stores, reducer/actions,
pending-op migrations, and legacy endpoint projections are part of the work.
An older client must neither overwrite unsupported new fields nor silently
turn cancelled/waiting tasks into pending ones. Negotiate client capabilities;
stop incompatible writes with a clear upgrade-needed response.

### Export/import and restore

Introduce a versioned export covering every user-owned task/project/link/date,
series/template/occurrence, reminder, block, tag/query, entry, and work log.
Keep import support for v1 snapshots with explicit migration diagnostics.
Exclude OAuth codes, bearer tokens, VAPID/private keys, provider credentials,
and live push subscriptions from portable exports. Include notification intent
and optional redacted delivery history, not operational leases or replayable
pending sends.

Import dry-run validates shape, all references, graph cycles, date/zone meaning,
occurrence uniqueness, and capacity before touching live state. Default restore
is delivery-disabled: restored reminders require an explicit rearm policy and
new channel enrollment; no old push fires merely because a backup was loaded.
Track an import epoch in sync so an old client must rebase instead of resurrecting
pre-restore data. Restore first uses bounded atomic payloads; staged large import
is an explicit later work item. Retention/purge must coordinate tombstones,
offline cursors, blocker references, audit, occurrence history, and receipts.

## 10. REST and MCP surface

Deliver each feature vertically through shared parse/domain/apply and both
interfaces. Avoid a schema-only rollout that leaves the LLM unable to use it.
Use a small set of discoverable semantic tools plus typed bulk commands; a
general code-execution tool is not necessary for basic power-user support.
How these operations are grouped into MCP tools, tiered by risk and migrated
from the current tools is planned in [MCP surface](mcp-surface.md).

| Tool family | Proposed operations |
| --- | --- |
| Context/query | `get_capabilities`, `resolve_time`, `list_tasks`, `get_task_context`, `get_project_context`, `get_ready_tasks`, `get_agenda`, `get_action_log` |
| Task structure | Extend `add_task`/`update_task`; `create_subtasks`, `move_task`, `reorder_tasks`, complete/reopen/cancel/delete; retain link/unlink tools |
| Dates | `set_task_date`/`remove_task_date` with explicit availability/target/deadline role |
| Time | Create/update/cancel blocks; `find_free_time`, `preview_schedule`; work-log/start/stop timer operations |
| Reminders | Create/update/pause/resume/snooze/acknowledge/list; inbox and delivery-status queries; channel enroll/test/disable |
| Recurrence | Create/list/update/pause/resume/end series; preview occurrences; exception/skip; template version/propagate; retain duty aliases |
| Organization | Projects, tags, saved queries, typed planning preferences |
| Bulk/history | `preview_changes`, `apply_changes`, `undo_changes`; export/import dry-run |

REST exposes the corresponding resources and a command endpoint under a
versioned contract. Keep existing endpoints as adapters during migration.
MCP tool schemas must express tagged temporal inputs, enums, bounded lists,
mutually exclusive owner/trigger forms, expected revision, and command IDs.
Server parsing remains authoritative even if a host only understands a subset
of JSON Schema. Return machine-readable structured data and a concise text
summary; keep widget-render metadata optional.

Task context includes ancestors, immediate children plus subtree continuation,
effective dates and their sources, prerequisites/dependents, reminders, blocks,
work/session entries, and recurrence provenance. Lists support status,
project/subtree, tags, readiness/blocked reasons, date role/range, priority,
duration, waiting, recurrence, and text search. Use stable cursor pagination,
bounded subtree expansion, and deterministic sorting. Saved queries store a
validated filter AST, not model-authored SQL or arbitrary code.

Mutation results include changed entity revisions, IDs/ref map, side effects,
warnings, and notification status. Errors include a code, field path, affected
IDs, retryability, and recovery hints, such as `revision_conflict`,
`dependency_cycle`, `missing_anchor`, `ambiguous_local_time`, `overlap`,
`capacity_exceeded`, `channel_unconfigured`, and `upgrade_required`.

LLM-facing instructions should teach distinctions with examples and request
clarification only when the intent affects outcome: date/zone ambiguity, hard
versus aspirational commitment, unknown effort, or proposed changes outside
the user's authorized scope. Broad capture can proceed with unresolved
planning assumptions recorded and returned. Never present a reminder as
delivering if no external channel is ready, or a proposed schedule as committed.

## 11. Worked intentions and acceptance scenarios

### “Finish the application by Friday; spend two hours on it tomorrow afternoon; remind me 15 minutes before.”

The LLM resolves Friday/tomorrow using the workspace zone and captured `now`.
It creates a group with action children (collect documents, draft, review,
submit), an explicit date deadline on the group, and links where required.
It asks or records estimates rather than inventing hidden values. A two-hour
block belongs to the drafting action; a relative block-start reminder uses
`offsetMinutes: -15`. Preview returns inherited deadline boundaries, capacity,
and push-channel readiness. Applying commits the graph/block/reminder together
or returns a capacity/conflict error with no partial result.

### “Every weekday at 09:00, remind me to check the queue, even if yesterday is unfinished.”

A timed calendar series in the user's zone creates independent task/reminder
occurrences. Existing unfinished tasks keep occurrence provenance. Spring/fall
behavior is returned. Generation ahead makes tomorrow's reminder durable;
completion does not spawn additional calendar instances. Notification delivery
continues without an open chat/browser tab.

### “Change the filter 30 days after I last replace it.”

Use completion-based calendar-day cadence, not a daily RRULE with INTERVAL=30.
Actual recorded completion sets the next occurrence. Duplicate completion
requests produce one successor. A delayed replacement moves the next one.
An explicitly chosen reminder can be attached to its target date; the target
does not become a hard deadline automatically.

### “Waiting for Alex; follow up Tuesday, and move the other work to Thursday.”

Waiting state stores its reason and an explicit follow-up reminder. Reminder
delivery does not resolve the blocker. Moving work changes selected movable
blocks without changing deadlines, fixed commitments, or unrelated tasks.
If Thursday has insufficient capacity, return feasible placements and the
remaining unscheduled effort. An offline edit made concurrently yields a
revision conflict with retained intent instead of silent replacement.

### Essential adversarial checks

- Date-only deadlines retain their date in UTC-12 and UTC+14; DST days and
  skipped dates obey the temporal contract; host `TZ` changes no results.
- Parent/group inheritance plus dependency links cannot create an effective
  cycle; cancelled blockers remain visible and unresolved.
- Adjacent blocks fit; overlapping blocks warn/reject; swaps validate the final
  agenda; a concurrent new reservation invalidates an old preview.
- Duplicate commands, cron invocations, completions, and recovered leases do
  not duplicate graph instances or durable delivery intent.
- Moving a deadline updates its relative reminders, invalidates unsent old
  generations, and preserves acceptance/acknowledgment history.
- Crash after provider acceptance, terminal-task races, disabled channels,
  quiet hours, expired sends, and offline device delivery have explicit states.
- Offline graph creation keeps stable references; conflicting edits survive;
  deletion tombstones prevent resurrection; restore requires rebase/rearm.
- Oversized graph/import rejection leaves zero partial live changes. Exports
  round-trip all user data and reveal no operational credentials.

## 12. Implementation order and definition of done

The companion checklist defines seven slices: (1) contract and temporal types,
(2) reliable commands/sync, (3) tasks/hierarchy/dates, (4) blocks/planning,
(5) reminders/delivery, (6) recurrence and templates, (7) broader power-user
queries/history and release hardening. Slice 5 can begin after slices 2–3 with
absolute/task-date reminders; block reminders require slice 4. Do not wait for
the UI redesign to expose usable backend tools.

Each slice ships parsers, persistence/migration, domain ops, REST, MCP, export/
import coverage, and relevant PWA data compatibility together. Feature gates
keep incomplete background execution inactive. Update `docs/overview.md`,
`docs/api.md`, and `docs/mcp-tools.md` as contracts land, with focused narrative
module docs for non-obvious invariants.

The backend milestone is complete when an LLM can create/decompose/schedule/
revise work and query why it is or is not feasible; a real device receives an
explicit reminder while the app is closed; recurrence exceptions and history
survive edits; offline changes reconcile without silent loss; and portable
restore preserves user intent without replaying old notifications. Passing
typecheck alone is not sufficient evidence for these behaviors.

Delivery configuration, the user's default timezone/working hours, and any
later external provider are setup choices, not blockers for writing this plan.
The implementation defaults and sharp edges above are deliberate proposals;
change them in this document when user feedback or actual platform limits
provide a reason, rather than silently drifting in a later session.
