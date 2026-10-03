# Slice 2 recurrence and execution hardening

The calendar foundation accepted a rule that could trap rrule in an internal
loop: HOURLY with INTERVAL=2 and BYHOUR=1 from midnight. A candidate-count guard
cannot stop a library call that never returns. Other filtered searches replayed
from DTSTART, and before() retained every historical match. Removing UNTIL before
searching an impossible calendar also discarded its useful termination boundary.

The series parser now permits only plain HOURLY/MINUTELY intervals with optional
COUNT/UNTIL. Daily and coarser frequencies retain calendar and time filters.
`seriesIterator.ts` indexes periods from the fixed anchor and traverses in either
direction, with an independent budget that charges empty periods too. Finite
UNTIL searches stop at their boundary. Budget failure is a typed error, never
proof of exhaustion. COUNT retains bounded replay to preserve its ordinal bound.
See [the canonical contract](../../shared/parse/recurrence.md).

We keep the tested rrule calendar masks for ordinal weekdays, week numbering,
and positional selection. The tradeoff is four internal imports, pinned to
2.8.1 in both packages. Differential fixtures compare safe native queries with
our indexed searches; bundling verifies those imports in Worker and PWA. Replacing
the whole calendar library would add substantially more calendar code.

Cursor membership uses a latest-at-or-before lookup and instant equality rather
than enumerating a duty's entire lifetime. Timezone parsing also has one codec:
Timezone aliases IanaTimezone, accepting Intl-valid named aliases across differing
ICU versions while preserving correctly cased input spelling.

The planned materialization race was separate from calendar math. If a newer plan
commits first, an older active-only insert could still create an obsolete task even
though its cursor update loses. The executor now inserts only when the duty is
active and the live cursor precedes that occurrence. Targeted occurrence conflicts
are benign; unrelated constraints still fail the atomic batch. Cursor updates
change both scheduling fields only when active and moving forward. Inserts must
precede the cursor update in the same batch.

Existing unfinished tasks retain their duty identity and state. The current
[product contract](../power-user-todo.md) presents them as backlog; catch-up does
not detach them, defer them, or silently mark them done. This eliminates the
previously planned stale-task mutation. An occurrence ledger, revisions, drivers,
and planners still belong to later slices; the executor guards do not replace
those future concurrency contracts.

Real SQLite tests exercise newer-then-older apply, duplicate replay, pause/end
between planning and apply, unrelated constraint rollback, and injected failure
between insert and cursor. Calendar tests cover empty-rule budgets, decades-old
filtered cursors, positional filters, DST folds/gaps, and a skipped dateline day.
