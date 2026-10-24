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

## Out of scope for now

- Routines lists repeating tasks; duties themselves aren't shown or edited.
- No editing of titles, notes, links or subtasks yet; no project management.
- The Ready now widget has no chips: Glance can't scroll horizontally.
