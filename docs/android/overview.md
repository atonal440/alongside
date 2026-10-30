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
- **Projects** and **Routines**: repeating series (duties) soonest first, then older repeating tasks that are not in a series. Tapping a series opens its sheet: title, notes, kind and catch-up, Pause / Resume, End. A task made from a series has the same sheet under "Edit repeat".
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

1. `domain/QuickAddParser.kt` is a deterministic parser for dates, times of day and repeats ("tomorrow at 5pm", "every other thursday", "the 1st and 15th of every month"). It resolves against the phone's local clock into a local date, an optional local time and an RRULE, and cuts those phrases out of the text. A small model is unreliable at calendar arithmetic, so it never does any. Vague phrases ("morning", "next week", "at 5") set `approx` and the sheet says it guessed. Its spec is the table of cases in `app/app/src/test/resources/quickadd-parse-cases.json`; every fixed phrasing gets a row.
2. `data/ai/OnDeviceQuickAdd.kt` sends what is left to Gemini Nano through the ML Kit GenAI Prompt API (beta, AICore) and reads title, notes and kind (action or plan) from a JSON reply. It retries once if the reply does not parse. The model can be missing, downloading or unsupported; the sheet reports that and the parser still fills date, time and repeat.

### The sheet

What the stages find prints as ordinary app UI, already filled in, and each piece is tappable:

- **What** prints first: the title (the parser's leftover text, then Nano's rewording once it answers) with Action/Plan chips. Anything the person edits while the model is still thinking is kept (`TapeDraft.withModel`).
- **When** prints if a day was found: day and time chips (date and time pickers, quick days behind a tap on the day), and a read-only repeat chip when the sentence had one, with a note that it starts on that day and that each one shows up when it's due. A note also says when the reading was a guess (`approx`).
- **Notes** prints if the model returned any. **Project** prints if the sheet was opened inside a project.
- After the first answer the text box asks the questions that are still open, in order: When (when no day was found; the answer goes through the same parser), Notes, Project (chips). Each can be skipped, and a skipped or removed element is not asked again. While the model runs the box waits, so a late reply cannot move the question under a half-typed answer.
- A perforated line under the newest element tears the sheet off: dragging it down creates the task and closes the sheet, and releasing early or cancelling springs it back. A task needs a title within the length limits before the line appears. Accessibility services get the same action without a drag.

The element order and rules (what is asked next, how the model result merges) are `domain/QuickAddTape.kt`, covered by `QuickAddTapeTest`. Long-press the "New task" title to print an "Under the hood" element with the parser and model timings, the phrases that were cut and the raw model reply, so a misread can be judged on a real device.

Three more sections are never asked for. Once the task has a title the text box offers dashed **+ Kickoff note**, **+ Not before** and **+ Waiting on** chips (hidden while an answer is half typed); each prints a card when answered. Waiting on is a search over open tasks and each pick adds a row, and a row's X stops waiting on it.

They are written through three sync intents (`data/sync/Intent.kt`): the kickoff note rides in `task.create`; **not before** is `Intent.SetAvailableFrom`, a `task.dates.set` that replaces availability and deadline together, so the envelope sends the server's current deadline back unchanged (and refuses if it cannot read it); **waiting on** is `Intent.Block`, a `link.add` of type `blocks` from the blocker to the new task, guarded by the link's own revision (null for a link never seen). All three show in the optimistic view at once. Deadline and subtasks are still not on the sheet.

A time makes the due date a local instant (not all-day). A sentence with a repeat makes a series with `duty.create` (see `docs/worker/duties.md`) instead of a task: the parsed date and time are the series' first occurrence, a time repeats at that clock time in the phone's zone, and no time makes an all-day series. The kickoff note goes on the series; Not before and Waiting on belong to one task, so a repeat leaves them out and the sheet says so. The worker makes each occurrence as a task only once it is due, so a new series shows in Routines straight away and its first task appears on the day. End dates (`UNTIL`, `COUNT`) are not parsed yet: "until november 1" stays in the title and the series has no end. The prompt lab that picked this design is in `scripts/llm-lab/` (see its README).

## Out of scope for now

- A series' schedule and project can't be edited (the worker fixes the schedule; end the series and start another). Series made on other devices appear, and can be paused, resumed, ended and have their template edited.
- No editing of titles, notes, links or subtasks yet; no project management.
- The Ready now widget has no chips: Glance can't scroll horizontally.
