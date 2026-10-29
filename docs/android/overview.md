---
tags: [android]
---

# Android app

`app/` is a native Android client: Kotlin, Jetpack Compose for the app and Glance for home-screen
widgets. It talks to the same worker as the PWA, keeps a copy of the workspace on the phone, and
queues every write so it works offline. The look comes from the "Alongside for Android" design
canvas: ink on lavender, peach for the primary action, lime for done, Figtree and Bricolage
Grotesque (bundled under `res/font/`, OFL).

## Running it

Open `app/` in Android Studio, or build from the command line with Android Studio's bundled JDK:

```sh
cd app
./gradlew :app:assembleDebug        # APK in app/build/outputs/apk/debug/
./gradlew :app:testDebugUnitTest    # JVM unit tests
```

`minSdk` is 26 (for `java.time`), `targetSdk`/`compileSdk` 37.

On first launch the app asks for a server address and access token (the worker's `AUTH_TOKEN`),
or offers sample data to look around without a server. The address is normalized before it is
saved (`https://` is assumed when no scheme is given) and rejected if it isn't an http(s) URL.
Cleartext HTTP is allowed only to `10.0.2.2`, `localhost` and `127.0.0.1`
(`res/xml/network_security_config.xml`), for a worker running on your computer. If the emulator
can't reach `10.0.2.2`, `adb reverse tcp:8787 tcp:8787` and `http://127.0.0.1:8787` is a reliable
alternative. The token lives in app-private SharedPreferences and is excluded from cloud backup
and device transfer.

## Screens and widgets

- **Tasks**: greeting, a one-line summary, search, quick views (Ready, Focus, Due soon, Waiting,
  Someday), the Focus section above Ready now, and folded Napping / Waiting groups. The filter
  sheet adds When, Project, Kind and Order by.
- **Task detail**: kickoff note with the next subtask, subtasks, dates, recurrence, and Mark done /
  Nap until / Wake.
- **Projects** and **Routines** (tasks with `recurrence` or a `duty_id`).
- **Widgets**: *Ready now* (resizable; a 4×2 shows the top three, taller sizes split into Today
  and Up next with an Add button), *Focus* (2×2, one task with a check) and *Today* (2×2 progress
  ring). Rows complete tasks in place; tapping elsewhere opens the app. Widgets follow the system
  light/dark theme.

To add a widget, long-press the home screen, choose Widgets, and find Alongside.

## How data flows

```
Compose UI / widgets ──► Repository ──► SyncEngine ──► command queue (sync_state.json)
        ▲                                   │ flush in order, then pull
        │                                   ▼
   Board (derived)  ◄── canonical + queue ◄── worker /api/v2 (changes, sync/snapshot, sync/delta)
```

`data/Repository.kt` is the single source of truth for both the app and the widgets, and a thin
wrapper over `data/sync/SyncEngine.kt`, which is a port of the PWA's sync engine; see
[Android sync](sync.md) for the design.

- **Reads** come from the canonical workspace (the server's last committed state, kept current by
  snapshot and delta pulls) with the unconfirmed commands replayed on top. `domain/TaskLogic.kt`
  turns that into a `Board`: each top-level task's bucket (ready, focused, napping, someday,
  waiting, done), date labels and sort order. The board is rebuilt on every change and once a
  minute, so naps and focus expire on screen without a sync.
- **Writes** are guarded v2 commands. Each is queued with the revision it was made against and shown
  at once; the queue is sent in order. A network or server error leaves it queued and stops the
  flush; a refusal moves it to Settings → "needs attention" (Try again / Discard) instead of losing
  it. A change made on another device meanwhile is reported as a conflict, not overwritten.
- **Creating and completing** mint their ids on the phone (the task and command ids, and a repeating
  task's successor), so a retry after a lost response replays the original result
  ([stable creation](../shared/reliable-creation.md), [reliable completion](../shared/reliable-completion.md)).
- **Switching** server, token or sample mode resets the engine and clears the queue; in-flight work
  from the old source checks a generation counter and discards its results.
- **Widgets** render from the same state and sync in the background when the last pull is more than
  15 minutes old or writes are waiting.

Files are written through a temp file and rename.

## Quick add with the on-device model (experiment)

The New task sheet (`ui/screens/QuickAddSheet.kt`) is a sheet that grows one element at a time. Saying the task in the text box runs two stages on the phone:

1. `domain/QuickAddParser.kt` is a deterministic parser for dates, times of day and repeats ("tomorrow at 5pm", "every other thursday", "the 1st and 15th of every month"). It resolves against the phone's local clock into a local date, an optional local time and an RRULE, and cuts those phrases out of the text. A small model is unreliable at calendar arithmetic, so it never does any. Vague phrases ("morning", "next week", "at 5") set `approx` and the sheet says it guessed. The same table of cases (`scripts/llm-lab/fixtures/parse-cases.json`) runs against the JS prototype and this port, so change them together.
2. `data/ai/OnDeviceQuickAdd.kt` sends what is left to Gemini Nano through the ML Kit GenAI Prompt API (beta, AICore) and reads title, notes and kind (action or plan) from a JSON reply. It retries once if the reply does not parse. The model can be missing, downloading or unsupported; the sheet reports that and the parser still fills date, time and repeat.

### The sheet

What the stages find prints as ordinary app UI, already filled in, and each piece is tappable:

- **What** prints first: the title (the parser's leftover text, then Nano's rewording once it answers) with Action/Plan chips. Anything the person edits while the model is still thinking is kept (`TapeDraft.withModel`).
- **When** prints if a day was found: day, time and repeat chips (date and time pickers, Daily/Weekly/Monthly), quick days, and a note when the reading was a guess (`approx`) or a time was set aside because of a repeat. Choosing a time drops the repeat and choosing a repeat drops the time, last one wins.
- **Notes** prints if the model returned any. **Project** prints if the sheet was opened inside a project.
- After the first answer the text box asks the questions that are still open, in order: When (when no day was found; the answer goes through the same parser), Notes, Project (chips). Each can be skipped, and a skipped or removed element is not asked again. While the model runs the box waits, so a late reply cannot move the question under a half-typed answer.
- A perforated line under the newest element tears the sheet off: dragging it down creates the task and closes the sheet, and releasing early or cancelling springs it back. A task needs a title within the length limits before the line appears. Accessibility services get the same action without a drag.

The element order and rules (what is asked next, how the model result merges, the time/repeat exclusion) are `domain/QuickAddTape.kt`, covered by `QuickAddTapeTest`. Long-press the "New task" title to print an "Under the hood" element with the parser and model timings, the phrases that were cut and the raw model reply, so a misread can be judged on a real device.

Only fields `Repository.create` can already send are on the sheet. A kickoff note, deadline, not-before date, subtasks and waiting-on have no create command yet; they need new sync intents first.

A time makes the due date a local instant (not all-day). A repeat is written with the due date as a `task.legacy-schedule.set` value, and because the worker's legacy repeat is date-only (a timed due date with a repeat is refused), a repeat wins and the time is left out; the sheet says so (`domain/Schedule.kt`). The worker's legacy recurrence profile still decides whether the rule itself is accepted. The prompt lab that picked this design is in `scripts/llm-lab/` (see its README).

## Out of scope for now

- Routines lists repeating tasks; duties themselves aren't shown or edited.
- No editing of titles, notes, links or subtasks yet; no project management.
- The Ready now widget has no chips: Glance can't scroll horizontally.
