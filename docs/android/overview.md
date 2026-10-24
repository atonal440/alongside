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
Compose UI / widgets ──► Repository ──► PendingOp queue (pending_ops.json)
        ▲                    │                   │ flush, in order
        │                    ▼                   ▼
   Board (derived)   workspace.json  ◄──  worker REST + /api/v2/changes
```

`data/Repository.kt` is the single source of truth for both the app and the widgets.

- **Reads** come from `workspace.json`, the last pulled workspace (`/api/tasks/sync`,
  `/api/projects/sync`, `/api/tasks/links`). `domain/TaskLogic.kt` turns it into a `Board`: each
  top-level task's bucket (ready, focused, napping, someday, waiting, done), date labels and
  sort order. The board is rebuilt on every change and once a minute, so naps and focus expire on
  screen without a sync.
- **Writes** are `PendingOp`s (`data/PendingOp.kt`). Each one is applied locally straight away,
  appended to `pending_ops.json`, and sent in order. A network failure, 5xx, 408 or 429 leaves it
  queued for the next attempt; a 4xx drops it and re-syncs so the screen stops showing it. A pull
  is only published when the queue is empty, and after each server reply the ops still waiting
  are laid back over it, so an earlier answer never undoes a later change.
- **Creating** uses the reliable `task.create` command
  ([stable creation](../shared/reliable-creation.md)). The task id and command id are minted on
  the phone, and the envelope is saved into the queued op before the first send, so a retry after
  a lost response replays the original result instead of making a second task. Project and due
  date follow as a legacy PATCH, which is safe to repeat. Other writes use the legacy endpoints
  (`PATCH /api/tasks/:id`, `POST /api/tasks/:id/complete`, `DELETE`).
- **Switching** server, token or sample mode bumps a generation counter and clears the queue;
  in-flight work from the old source checks it and discards its results.
- **Widgets** render from the cache and pull in the background when it is more than 15 minutes
  old or writes are waiting.

Files are written through a temp file and rename; the workspace cache goes through one ordered
writer, so the newest snapshot always wins.

## Out of scope for now

- Most writes still use the legacy endpoints rather than guarded v2 commands, so a stale edit is
  not detected as a conflict the way the PWA's queue detects it.
- Routines lists repeating tasks; duties themselves aren't shown or edited.
- No editing of titles, notes, links or subtasks yet; no project management.
- The Ready now widget has no chips: Glance can't scroll horizontally.
