package com.atonal440.alongside.data

import android.content.Context
import com.atonal440.alongside.data.sync.FileSyncStore
import com.atonal440.alongside.data.sync.Intent
import com.atonal440.alongside.data.sync.RetainedOp
import com.atonal440.alongside.data.sync.SyncEngine
import com.atonal440.alongside.data.sync.SyncStatus
import com.atonal440.alongside.data.sync.mintId
import com.atonal440.alongside.domain.Clock
import com.atonal440.alongside.domain.dueSchedule
import com.atonal440.alongside.domain.dutySchedule
import com.atonal440.alongside.domain.toWire
import com.atonal440.alongside.widget.AlongsideWidgets
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.merge
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime

/**
 * The one source of truth for the app and its widgets: a thin Android wrapper over [SyncEngine],
 * which is the phone's port of the PWA's sync engine (docs/android/sync.md). Screens call the
 * verbs below; each turns into guarded v2 commands, is shown at once and is sent in the background.
 */
class Repository private constructor(private val context: Context) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    private val _settings = MutableStateFlow(Settings.load(context))
    val settings: StateFlow<Settings> = _settings.asStateFlow()

    private val engine = SyncEngine(FileSyncStore(context.filesDir), apiFactory = {
        _settings.value.takeIf { it.isConnected && !it.sampleMode }?.let { AlongsideApi(it.serverUrl, it.token) }
    })

    val workspace: StateFlow<Workspace> = engine.workspace
    val sync: StateFlow<SyncStatus> = engine.status

    /** Changes the server refused, kept so they can be tried again or discarded. */
    val needsAttention: StateFlow<List<RetainedOp>> = engine.retained

    private val extraMessages = MutableSharedFlow<String>(extraBufferCapacity = 8)
    val messages: Flow<String> = merge(engine.messages, extraMessages)

    init {
        // Widgets redraw whenever what the screen shows changes (equal values are not re-emitted).
        scope.launch { engine.workspace.collect { AlongsideWidgets.updateAll(context) } }
    }

    private fun sourceKey(s: Settings) = if (s.sampleMode) SAMPLE_SOURCE else s.serverUrl.trim()

    /** Loads the stored queue and canonical copy once. Widgets call this before their first frame. */
    suspend fun ensureLoaded() {
        val s = _settings.value
        engine.load(sourceKey(s), if (s.sampleMode) SampleData.workspace() else null)
    }

    suspend fun updateSettings(settings: Settings) {
        val old = _settings.value
        val switchedSource = settings.sampleMode != old.sampleMode ||
            settings.serverUrl.trim() != old.serverUrl || settings.token.trim() != old.token
        Settings.save(context, settings)
        val saved = Settings.load(context)
        if (!switchedSource) {
            _settings.value = saved
            return
        }
        // Writes queued for the old source don't belong to the new one. The new settings become
        // visible in the same step as the reset, so a sync can't pair the new server with the old queue.
        engine.reset(sourceKey(saved), if (saved.sampleMode) SampleData.workspace() else null) { _settings.value = saved }
        if (saved.isConnected && !saved.sampleMode) engine.sync()
    }

    /** Sends queued writes, then pulls. */
    suspend fun refresh() {
        ensureLoaded()
        engine.sync()
    }

    fun refreshInBackground() {
        scope.launch { refresh() }
    }

    /** For widgets: sync if the last pull is older than [maxAgeMillis] or writes are waiting. */
    fun refreshIfStale(maxAgeMillis: Long) {
        val settings = _settings.value
        if (!settings.isConnected || settings.sampleMode || engine.status.value == SyncStatus.Syncing) return
        val syncedAt = engine.workspace.value.syncedAtMillis
        if (engine.hasPendingWrites || syncedAt == null || System.currentTimeMillis() - syncedAt > maxAgeMillis) refreshInBackground()
    }

    /** Commits [intents] and shows them at once; sending happens in the background. */
    private suspend fun write(vararg intents: Intent) {
        ensureLoaded()
        engine.commit(intents.toList())
        scope.launch { engine.sync() }
    }

    /** Marks a task done. Returns the id its next occurrence will have when it repeats. */
    suspend fun complete(id: String): String? {
        ensureLoaded()
        val ws = workspace.value
        val task = ws.task(id) ?: return null
        if (ws.tasks.any { it.parent_id == id && it.status == "pending" }) {
            extraMessages.tryEmit(OPEN_SUBTASKS_BLOCK_COMPLETE)
            return null
        }
        val successorId = if (task.recurrence != null) mintId("t") else null
        write(Intent.Complete(id, successorId))
        return successorId
    }

    /** Undo for [complete]: reopen the task and drop the successor it spawned, if any. */
    suspend fun reopen(id: String, spawnedId: String?) {
        // The successor goes first, and the reopen waits on it, so a refused delete can't leave two pending copies.
        write(*listOfNotNull<Intent>(spawnedId?.let(Intent::Delete), Intent.Reopen(id, spawnedId)).toTypedArray())
    }

    suspend fun setFocus(id: String, focused: Boolean) {
        write(Intent.Focus(id, if (focused) Clock.endOfToday().toWire() else null))
    }

    /** Snoozes a task until [until], or to someday when null. */
    suspend fun nap(id: String, until: Instant?) {
        write(if (until == null) Intent.Defer(id, "someday") else Intent.Defer(id, "until", until.toWire()))
    }

    suspend fun wake(id: String) {
        write(Intent.Defer(id, "none"))
    }

    /**
     * Deletes a task. The worker refuses to delete a task that has subtasks (done or not), so
     * that is checked here first, as the PWA does, rather than queueing a delete that can't land.
     * Returns false when refused.
     */
    suspend fun delete(id: String): Boolean {
        ensureLoaded()
        if (hasSubtasks(id)) {
            extraMessages.tryEmit(SUBTASKS_BLOCK_DELETE)
            return false
        }
        write(Intent.Delete(id))
        return true
    }

    fun hasSubtasks(id: String) = workspace.value.tasks.any { it.parent_id == id }

    suspend fun create(
        title: String,
        notes: String?,
        projectId: String?,
        plan: Boolean,
        due: LocalDate?,
        dueTime: LocalTime? = null,
        kickoffNote: String? = null,
        availableFrom: LocalDate? = null,
        waitingOn: List<String> = emptyList(),
        repeat: String? = null,
    ) {
        if (repeat != null) {
            // A repeat is a series (`duty.create`), starting at the first occurrence; the worker makes each task when it is due.
            // With no date the series starts today (or at the next matching day, which the rule decides).
            val s = dutySchedule(repeat, due ?: Clock.today(), dueTime, Clock.zone)
            write(Intent.CreateDuty(mintId("d"), title, notes, if (plan) "plan" else "action", projectId, "next", s.rrule, s.dtstart, s.timezone, kickoffNote))
            return
        }
        val id = mintId("t")
        // Project and due date are their own commands, each guarded by the revision the create gives the task.
        // A time makes the due date a local instant instead of an all-day date.
        write(
            *listOfNotNull<Intent>(
                Intent.Create(id, title, notes, if (plan) "plan" else "action", kickoffNote),
                projectId?.let { Intent.SetProject(id, it) },
                due?.let {
                    val s = dueSchedule(it, dueTime, Clock.zone)
                    Intent.SetDue(id, s.dueDate, dueAllDay = s.allDay)
                },
                availableFrom?.let { Intent.SetAvailableFrom(id, it.toString(), Clock.zone.id) },
                *waitingOn.distinct().map { Intent.Block(id, it) }.toTypedArray(),
            ).toTypedArray(),
        )
    }

    /** Rewrites a series' title, notes, kind and catch-up for the occurrences still to come (`duty.content.set`). */
    suspend fun editSeries(id: String, title: String, notes: String?, plan: Boolean, catchUpAll: Boolean) {
        write(Intent.SetDutyContent(id, title, notes, if (plan) "plan" else "action", if (catchUpAll) "all" else "next"))
    }

    /** Pauses, resumes or ends a series. Ending is final. */
    suspend fun setSeriesStatus(id: String, status: String) = write(Intent.SetDutyStatus(id, status))

    /** Put every refused change back at the end of the queue as a new command, and send it. */
    suspend fun retryNeedsAttention() {
        ensureLoaded()
        engine.retryRetained(needsAttention.value.map { it.id })
        engine.sync()
    }

    /** Forget the refused changes the person was shown ([seen]); anything refused since stays. */
    suspend fun discardNeedsAttention(seen: List<RetainedOp>) {
        engine.discardRetained(seen.map { it.id })
    }

    companion object {
        private const val SAMPLE_SOURCE = "sample"

        /** Same wording as the PWA and the worker. */
        const val SUBTASKS_BLOCK_DELETE = "This task has subtasks; delete or detach them first."
        const val OPEN_SUBTASKS_BLOCK_COMPLETE = "Complete the open subtasks first."

        @Volatile private var instance: Repository? = null

        fun get(context: Context): Repository = instance ?: synchronized(this) {
            instance ?: Repository(context.applicationContext).also { instance = it }
        }
    }
}
