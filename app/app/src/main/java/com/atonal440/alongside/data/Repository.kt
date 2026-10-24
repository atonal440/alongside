package com.atonal440.alongside.data

import android.content.Context
import com.atonal440.alongside.domain.Clock
import com.atonal440.alongside.domain.toWire
import com.atonal440.alongside.widget.AlongsideWidgets
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.File
import java.io.IOException
import java.time.Instant
import java.time.LocalDate
import java.util.UUID

sealed interface SyncStatus {
    data object Idle : SyncStatus
    data object Syncing : SyncStatus
    data class Failed(val message: String) : SyncStatus
}

/**
 * The one source of truth for the app and its widgets. Reads come from a cached copy of the
 * workspace on disk so the list and widgets show something offline; every write is applied
 * locally first, then sent to the worker, and the server's row replaces the guess. A refused
 * write rolls back by re-syncing and is reported through [messages].
 */
class Repository private constructor(private val context: Context) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val cacheFile = File(context.filesDir, "workspace.json")
    private val writeLock = Mutex()
    private var loaded = false

    private val _settings = MutableStateFlow(Settings.load(context))
    val settings: StateFlow<Settings> = _settings.asStateFlow()

    private val _workspace = MutableStateFlow(Workspace())
    val workspace: StateFlow<Workspace> = _workspace.asStateFlow()

    private val _sync = MutableStateFlow<SyncStatus>(SyncStatus.Idle)
    val sync: StateFlow<SyncStatus> = _sync.asStateFlow()

    private val _messages = MutableSharedFlow<String>(extraBufferCapacity = 8)
    val messages: SharedFlow<String> = _messages

    private val api: AlongsideApi?
        get() = _settings.value.takeIf { it.isConnected && !it.sampleMode }?.let { AlongsideApi(it.serverUrl, it.token) }

    /** Loads the disk cache once. Widgets call this before their first frame. */
    suspend fun ensureLoaded() {
        if (loaded) return
        withContext(Dispatchers.IO) {
            if (!loaded) {
                val cached = runCatching { AlongsideApi.json.decodeFromString<Workspace>(cacheFile.readText()) }.getOrNull()
                if (cached != null && _workspace.value.tasks.isEmpty()) _workspace.value = cached
                loaded = true
            }
        }
    }

    fun updateSettings(settings: Settings) {
        val switchedSource = settings.sampleMode != _settings.value.sampleMode ||
            settings.serverUrl.trim() != _settings.value.serverUrl || settings.token.trim() != _settings.value.token
        Settings.save(context, settings)
        _settings.value = Settings.load(context)
        if (switchedSource) {
            publish(if (settings.sampleMode) SampleData.workspace() else Workspace())
            if (!settings.sampleMode) scope.launch { refresh() }
        }
    }

    suspend fun refresh() {
        ensureLoaded()
        if (_settings.value.sampleMode) {
            if (_workspace.value.tasks.isEmpty()) publish(SampleData.workspace())
            return
        }
        val api = api ?: return
        _sync.value = SyncStatus.Syncing
        try {
            val tasks = api.allTasks()
            val projects = api.allProjects()
            val links = api.links()
            publish(Workspace(tasks, projects, links, System.currentTimeMillis()))
            _sync.value = SyncStatus.Idle
        } catch (e: IOException) {
            _sync.value = SyncStatus.Failed(e.friendly())
        }
    }

    fun refreshInBackground() {
        scope.launch { refresh() }
    }

    /** Marks a task done. Returns the successor id when a recurring task spawned one. */
    suspend fun complete(id: String): String? {
        ensureLoaded()
        val before = _workspace.value.task(id) ?: return null
        val done = before.copy(status = "done", focused_until = null, updated_at = Clock.now().toWire())
        return mutate(local = { it.replace(done) }) { api ->
            val result = api.completeTask(id)
            _workspace.value = _workspace.value.replace(result.completed).let { ws -> result.next?.let(ws::upsert) ?: ws }
            result.next?.id
        }
    }

    /** Undo for [complete]: reopen the task and drop the successor it spawned, if any. */
    suspend fun reopen(id: String, spawnedId: String?) {
        val before = _workspace.value.task(id) ?: return
        mutate(local = { ws -> ws.replace(before.copy(status = "pending")).let { if (spawnedId != null) it.remove(spawnedId) else it } }) { api ->
            if (spawnedId != null) api.deleteTask(spawnedId)
            val row = api.updateTask(id, buildJsonObject { put("status", "pending") })
            _workspace.value = _workspace.value.replace(row)
        }
    }

    suspend fun setFocus(id: String, focused: Boolean) {
        val until = if (focused) Clock.endOfToday().toWire() else null
        patch(id, buildJsonObject { put("focused_until", until.json()) }) { it.copy(focused_until = until) }
    }

    /** Snoozes a task until [until], or to someday when null. */
    suspend fun nap(id: String, until: Instant?) {
        val kind = if (until == null) "someday" else "until"
        val untilText = until?.toWire()
        patch(id, buildJsonObject {
            put("defer_kind", kind)
            put("defer_until", untilText.json())
            put("focused_until", JsonNull)
        }) { it.copy(defer_kind = kind, defer_until = untilText, focused_until = null) }
    }

    suspend fun wake(id: String) {
        patch(id, buildJsonObject {
            put("defer_kind", "none")
            put("defer_until", JsonNull)
        }) { it.copy(defer_kind = "none", defer_until = null) }
    }

    suspend fun delete(id: String) {
        mutate(local = { it.remove(id) }) { api -> api.deleteTask(id) }
    }

    suspend fun create(title: String, notes: String?, projectId: String?, plan: Boolean, due: LocalDate?) {
        val now = Clock.now().toWire()
        val draft = Task(
            id = "local_" + UUID.randomUUID(),
            title = title,
            notes = notes,
            project_id = projectId,
            task_type = if (plan) "plan" else "action",
            due_date = due?.atTime(12, 0)?.atZone(java.time.ZoneOffset.UTC)?.toInstant()?.toWire(),
            due_all_day = due?.let { true },
            created_at = now,
            updated_at = now,
        )
        mutate(local = { it.upsert(draft) }) { api ->
            val row = api.createTask(buildJsonObject {
                put("title", title)
                notes?.let { put("notes", it) }
                put("project_id", projectId.json())
                put("task_type", draft.task_type)
                due?.let { put("due_date", it.toString()) }
            })
            _workspace.value = _workspace.value.remove(draft.id).upsert(row)
        }
    }

    private suspend fun patch(id: String, body: JsonObject, local: (Task) -> Task) {
        val before = _workspace.value.task(id) ?: return
        mutate(local = { it.replace(local(before)) }) { api ->
            _workspace.value = _workspace.value.replace(api.updateTask(id, body))
        }
    }

    /**
     * Applies [local] straight away, then runs [remote] against the worker. Sample mode stops after
     * the local step. Any failure re-syncs so the screen stops showing a write that didn't land.
     */
    private suspend fun <T> mutate(local: (Workspace) -> Workspace, remote: suspend (AlongsideApi) -> T?): T? {
        publish(local(_workspace.value))
        val api = api ?: return null
        return writeLock.withLock {
            try {
                remote(api).also { publish(_workspace.value) }
            } catch (e: IOException) {
                _messages.tryEmit(e.friendly())
                refresh()
                null
            }
        }
    }

    private fun publish(ws: Workspace) {
        _workspace.value = ws
        scope.launch(Dispatchers.IO) {
            runCatching { cacheFile.writeText(AlongsideApi.json.encodeToString(Workspace.serializer(), ws)) }
            AlongsideWidgets.updateAll(context)
        }
    }

    private fun IOException.friendly(): String = when (this) {
        is ApiException -> message ?: "Something went wrong."
        is java.net.UnknownHostException, is java.net.ConnectException -> "Can't reach the server. Showing what's saved."
        is java.net.SocketTimeoutException -> "The server took too long to answer."
        else -> message ?: "Something went wrong."
    }

    private fun String?.json() = this?.let { JsonPrimitive(it) } ?: JsonNull

    companion object {
        @Volatile private var instance: Repository? = null

        fun get(context: Context): Repository = instance ?: synchronized(this) {
            instance ?: Repository(context.applicationContext).also { instance = it }
        }
    }
}
