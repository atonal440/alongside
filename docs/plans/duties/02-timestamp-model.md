# Foundation 02 — The Timestamp Model: Minute-Resolution UTC Everywhere

Part of `docs/plans/duties.md`. Read alongside `00-recurrence-and-triggering.md`.
This document records a substrate decision that predates duties conceptually but
lands *with* them, because duties are the first feature willing to change
existing behavior and migrate data: **Alongside abandons date-only ("day")
resolution and stores every timestamp as a UTC instant at minute resolution.**

This is app-wide, not duties-only. It is the reason the trigger design in `00`
is simpler than it first appears — much of what looked like duty complexity was
really date-only complexity in disguise.

## The decision

- Every scheduling timestamp — `due_date`, `defer_until`, `focused_until`,
  a duty's `dtstart`, and a spawned instance's `occurrence_at` — is a UTC ISO-8601
  instant at **minute** resolution (`YYYY-MM-DDTHH:MM:00Z`; seconds truncated,
  no offset other than `Z`).
- There are **no date-only fields**, and **no timezone is ever stored on a
  timestamp**. The one anticipated exception is a duty's optional *anchor zone* —
  a rule-expansion parameter, not a property of any stored time — described under
  the DST tradeoff below.
- Timezone is otherwise a **presentation concern**: the PWA formats instants into
  the viewer's local zone at render time. The server never needs to know a
  viewer's zone to decide what to spawn.
- Audit timestamps (`created_at`, `updated_at`) keep their existing **full**
  precision (sub-second UTC ISO), because last-write-wins merge orders on
  `updated_at` and minute-coarsening would manufacture ties. "Minute resolution"
  is a statement about the scheduling values a human sets, not about internal
  bookkeeping.
- Minute resolution is also the **substrate for planned features** — reminders,
  timeboxing, and other time-of-day behaviors — not merely duty correctness. That
  roadmap is why Phase 1 goes all the way to timezone-aware recurrence (the anchor
  zone, below) rather than treating it as a curiosity.

## Why date-only was a false economy

Date-only resolution was adopted to *avoid* timezones. It doesn't. A calendar
day is not a globally agreed interval — 2026-06-30 begins and ends at different
absolute instants in Auckland and Los Angeles. So the moment you ask a
date-only system anything time-sensitive — "is this due today?", "should this
duty spawn now?", "is this focus window expired?" — you must supply a zone to
turn the date into an interval. Date-only didn't remove the timezone; it deferred
it to every read and smuggled an implicit UTC (or implicit local) zone in at each
comparison site.

The symptoms are already in the codebase:

- The worker carries two brands, `IsoDate` and `IsoDateTime`, and cross-field
  invariants exist only to keep them from mixing.
- The existing PWA test-harness notes call out **two distinct time vocabularies**
  — a date-only `today` for calendar comparisons and a datetime `nowIso` for
  focus/defer expiry — and warn that feeding one where the other is expected is a
  bug (a date-only value compares like midnight, so a focus that expired at 10:00
  looks live until tomorrow).
- The recurrence parser spends most of its length (`isDateOnlyProfile` and its
  helpers in `shared/parse/recurrence.ts`) *enforcing* date-only-ness against a
  library (`rrule`) whose natural mode is datetime.

One instant type removes all three. This is why the change is a simplification.

## What it changes

### Removed
- The `IsoDate` brand as a domain/storage type. It survives, if at all, only as
  an input to a presentation formatter. Domain fields that were `IsoDate | null`
  become `IsoDateTime | null`.
- The date-only RRULE profile: `isDateOnlyProfile` and the special-casing that
  rejects time parts. RRULEs are expanded with a datetime `DTSTART` in UTC.
- The `todayInZone` resolver and the `timezone`-in-the-spawn-path plumbing that
  `00`/Stage 5 originally described. The materializer takes a UTC `now`, not a
  zone-resolved `today`.
- The "two vocabularies" hazard — there is one vocabulary, `IsoDateTime` (UTC).

### Enabled
- **Time-of-day and sub-day recurrence**, which were out of scope purely because
  of date-only. "Every weekday at 09:00 UTC", "every 30 minutes" are now
  expressible. (Sub-cron-interval recurrence — e.g. every 5 minutes against a
  15-minute cron — spawns with up to one cron interval of lag; lazy-on-read
  closes the gap the instant a client looks. Note it, don't forbid it.)
- **`now`-based materialization.** `occurrencesBetween(parts, dtstart, after,
  through = now)` compares instants. No zone, no ambiguity, deterministic.

### Migrated
- Existing date-only `due_date` values (`"2026-06-30"`) become
  `"2026-06-30T00:00:00Z"` — midnight UTC. This is a deterministic, lossy-forward
  reinterpretation; document it in the migration header. Any UI that only ever
  showed a date keeps showing a date (format the instant back to its date part).
- Existing date-only recurrence rules are reinterpreted with the midnight-UTC
  `DTSTART` derived from the task's `due_date`, then folded into the duty they
  become (see the master's Migration Strategy).
- `defer_until` / `focused_until` are already datetime; they only need to be
  understood as UTC minute-resolution going forward (truncate seconds on new
  writes).

## The DST tradeoff, and the anchor-zone escape hatch

Storing and evaluating recurrence in UTC means a rule fixed at `14:00Z` fires at
09:00 in New York in winter and 10:00 in summer. For a recurring reminder pinned
to someone's morning, that drift is a real UX cost — and it is the classic reason
calendar systems attach a timezone to recurring events (iCal's `DTSTART;TZID`).

**Decision: ship it in Phase 1.** Because the planned reminders / timeboxing work
wants stable wall-clock behavior — and because the Stage 8 editor would otherwise
imply a "daily at 9" that Phase 1 quietly breaks after DST — the optional anchor
zone is **in Phase 1**, not deferred. A `duties.timezone` column lands in Stage 1
and `occurrencesBetween` is anchor-zone-aware in Stage 2. Two modes:

- **Default (no zone set):** rules expand in UTC. Simple, zero stored state, no
  drift *within* UTC. This is what every duty with `timezone = NULL` does.
- **Anchor zone (opt-in per duty):** a duty carries an *optional* IANA zone — the
  zone whose wall clock the rule is pinned to (`09:00 America/New_York`). It is
  used **only to expand the rule**; the occurrences it produces are still stored
  as UTC instants. Unset ⇒ UTC expansion. It never puts a timezone on a timestamp
  and is never a user-global setting.

The anchor zone is *intent*, not a creation fact. It **defaults** to the
creator's zone, but it really means "which wall clock this rule follows," and it
is editable — e.g. if the user relocates, or if they create a duty while
travelling but want it pinned to home. A duty with no wall-clock intent leaves it
unset and accepts UTC cadence.

### Two conversions, two zones

The subtlety worth internalizing: **expanding a rule** and **displaying an
instant** are different conversions that use different zones, with UTC as the
fixed point between them.

```
      anchor zone (creator's intent)          viewer's zone (reader's frame)
rule ───────────────────────────────▶ UTC instant ───────────────────────────────▶ display
     expansion (at spawn, server)     (canonical       rendering (at render, client)
                                        storage)
```

- **Expansion** (rule → UTC) uses the *duty's anchor zone*, applied per occurrence
  so each date picks up the correct DST offset. This is where "09:00 NY" becomes a
  concrete `14:00Z` or `13:00Z`.
- **Rendering** (UTC → local) uses *whoever is looking*, in their device's zone,
  which may be nothing like the anchor zone.

Worked example — a "09:00 daily" duty anchored to `America/New_York`, across the
2026-03-08 spring-forward:

| Date | Intent (NY wall clock) | UTC expansion (rule fixed at 14:00Z) | Anchor-zone expansion (09:00 NY) |
|---|---|---|---|
| Mar 7 | 09:00 | stores `14:00Z` → 09:00 ✓ | stores `14:00Z` → 09:00 ✓ |
| **Mar 8** (spring forward) | 09:00 | stores `14:00Z` → **10:00 ✗** | stores **`13:00Z`** → 09:00 ✓ |
| Mar 9 | 09:00 | stores `14:00Z` → 10:00 ✗ | stores `13:00Z` → 09:00 ✓ |

UTC expansion holds the *UTC* value constant (`14:00Z`) and lets local time drift;
anchor-zone expansion holds the *local* time constant (09:00) and lets the stored
UTC instant shift (`14:00Z` → `13:00Z`). Both still store UTC — the day straddling
the boundary just comes out 23 hours after the previous one instead of 24, which
is exactly what keeps 09:00-local stable.

And the two zones are independent. That same NY-anchored 09:00 duty, on the Mar 7
row (`14:00Z`), viewed from **Tokyo**, renders as **23:00** — correctly, because
09:00 New York *is* 23:00 the same day in Tokyo. The anchor zone preserves the
creator's intent; the viewer's zone shows it in the reader's frame; the stored UTC
instant is what both agree on.

The invariant, either mode: **stored instants are always UTC.** A timezone, when
it appears, is an input to rule *expansion* (the anchor zone) or to *display* (the
viewer's zone) — never a property of a stored timestamp. And note the anchor zone
is a *per-duty rule parameter*, a different mechanism from the global
"resolve today in the user's zone" resolver this decision deletes: there is no
user-wide timezone setting driving what spawns.

## Presentation stays honest

This is the display half of the two-conversions model above, plus its input
mirror. Dropping date-only does not mean the UI shows raw UTC. The PWA continues
to render friendly values — "Today", "Jun 30", "in 2 days", a due time when one is
set — by formatting the stored UTC instant in the viewer's local zone. A date picker still
exists; it just resolves the chosen local date (and optional time) to a UTC
instant at submit, the same parse-at-the-boundary discipline every other input
follows. The difference from before is that the ambiguity is resolved **once, at
the edge, in the direction of an instant**, instead of being re-resolved at every
comparison.

## Scope and sequencing

Because this touches existing task code — worker `IsoDate` usage, the PWA's
`formatDue` / `taskSort` null-date sentinel / readiness due-window logic, and the
task edit form's date input — it is executed as **Part A of Stage 1**
(`stage-1-schema-and-migration.md`), ahead of and alongside the duties schema, so
the two table migrations happen in one pass rather than migrating `tasks` twice.
It could be pulled out as a standalone precursor stage if you'd rather land the
substrate change before any duties work; the content is self-contained here for
that reason.
