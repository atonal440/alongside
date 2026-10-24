package com.atonal440.alongside.data

import android.content.Context
import com.atonal440.alongside.domain.Clock
import com.atonal440.alongside.domain.toWire
import com.atonal440.alongside.widget.AlongsideWidgets
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.File
import java.io.IOException
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import java.util.UUID

sealed interface SyncStatus {
    data object Idle : SyncStatus
    data object Syncing : SyncStatus
    data class Failed(val message: String) : SyncStatus
}

/**
 * The one source of truth for the app and its widgets.
 *
 * Reads come from a cached copy of the workspace on disk, so the list and widgets show something
 * offline. Every write is applied locally first and queued as a [PendingOp] (also on disk); the
 * queue is replayed in order against the worker. A network failure leaves the op queued for the
 * next attempt; a refusal (4xx) drops it and re-syncs so the screen stops showing it. Pulls only
 * happen once the queue has drained, so a pull never overwrites a change that hasn't landed.
 *
 * Switching server, token or sample mode bumps [generation]; in-flight work from the old source
 * checks it before publishing and gives up if it changed.
 */
class Repository private constructor(private val context: Context) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val cacheFile = File(context.filesDir, "workspace.json")
    private val queueFile = File(context.filesDir, "pending_ops.json")
    private val opsSerializer = ListSerializer(PendingOp.serializer())
    private val writeLock = Mutex()
    private val queueLock = Any()
    private val cacheWrites = Channel<Workspace>(Channel.CONFLATED)
    @Volatile private var loaded = false
    @Volatile private var generation = 0

    private val _settings = MutableStateFlow(Settings.load(context))
    val settings: StateFlow<Settings> = _settings.asStateFlow()

    private val _workspace = MutableStateFlow(Workspace())
    val workspace: StateFlow<Workspace> = _workspace.asStateFlow()

    private val _queue = MutableStateFlow<List<PendingOp>>(emptyList())

    private val _sync = MutableStateFlow<SyncStatus>(SyncStatus.Idle)
    val sync: StateFlow<SyncStatus> = _sync.asStateFlow()

    private val _messages = MutableSharedFlow<String>(extraBufferCapacity = 8)
    val messages: SharedFlow<String> = _messages

    /** Successor ids spawned by recurring completions, kept for [complete]'s undo. */
    private val spawned = mutableMapOf<String, String>()

    init {
        startCacheWriter()
    }

    private val api: AlongsideApi?
        get() = _settings.value.takeIf { it.isConnected && !it.sampleMode }?.let { AlongsideApi(it.serverUrl, it.token) }

    /** Loads the disk cache and the write queue once. Widgets call this before their first frame. */
    suspend fun ensureLoaded() {
        if (loaded) return
        withContext(Dispatchers.IO) {
            synchronized(this@Repository) {
                if (loaded) return@withContext
                val cached = runCatching { AlongsideApi.json.decodeFromString<Workspace>(cacheFile.readText()) }.getOrNull()
                if (cached != null && _workspace.value.tasks.isEmpty()) _workspace.value = cached
                val ops = runCatching { AlongsideApi.json.decodeFromString(opsSerializer, queueFile.readText()) }.getOrNull()
                if (ops != null) _queue.value = ops
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
            // Writes queued for the old source don't belong to the new one.
            generation++
            updateQueue { emptyList() }
            _sync.value = SyncStatus.Idle
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
        val gen = generation
        _sync.value = SyncStatus.Syncing
        if (!flush()) return
        writeLock.withLock {
            if (gen != generation) return
            try {
                val tasks = api.allTasks()
                val projects = api.allProjects()
                val links = api.links()
                if (gen != generation) return
                if (_queue.value.isNotEmpty()) {
                    // Writes were queued while this pull was in flight; publishing it would hide
                    // them. Their flush pulls again once they've landed.
                    resyncNeeded = true
                    _sync.value = SyncStatus.Idle
                    return
                }
                publish(Workspace(tasks, projects, links, System.currentTimeMillis()))
                _sync.value = SyncStatus.Idle
                resyncNeeded = false
            } catch (e: IOException) {
                if (gen == generation) _sync.value = SyncStatus.Failed(e.friendly())
            }
        }
    }

    fun refreshInBackground() {
        scope.launch { refresh() }
    }

    /** For widgets: pull from the worker if the cache is older than [maxAgeMillis] or writes are waiting. */
    fun refreshIfStale(maxAgeMillis: Long) {
        val settings = _settings.value
        if (!settings.isConnected || settings.sampleMode || _sync.value == SyncStatus.Syncing) return
        val syncedAt = _workspace.value.syncedAtMillis
        if (_queue.value.isNotEmpty() || syncedAt == null || System.currentTimeMillis() - syncedAt > maxAgeMillis) refreshInBackground()
    }

    /** Marks a task done. Returns the successor id when a recurring task spawned one. */
    suspend fun complete(id: String): String? {
        ensureLoaded()
        val before = _workspace.value.task(id) ?: return null
        val done = before.copy(status = "done", focused_until = null, updated_at = Clock.now().toWire())
        mutate(PendingOp.Complete(id)) { it.replace(done) }
        return synchronized(spawned) { spawned.remove(id) }
    }

    /** Undo for [complete]: reopen the task and drop the successor it spawned, if any. */
    suspend fun reopen(id: String, spawnedId: String?) {
        val before = _workspace.value.task(id) ?: return
        mutate(PendingOp.Reopen(id, spawnedId)) { ws ->
            ws.replace(before.copy(status = "pending")).let { if (spawnedId != null) it.remove(spawnedId) else it }
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
        mutate(PendingOp.Delete(id)) { it.remove(id) }
    }

    suspend fun create(title: String, notes: String?, projectId: String?, plan: Boolean, due: LocalDate?) {
        val now = Clock.now().toWire()
        val draft = Task(
            id = LOCAL_ID_PREFIX + UUID.randomUUID(),
            title = title,
            notes = notes,
            project_id = projectId,
            task_type = if (plan) "plan" else "action",
            due_date = due?.atTime(12, 0)?.atZone(ZoneOffset.UTC)?.toInstant()?.toWire(),
            due_all_day = due?.let { true },
            created_at = now,
            updated_at = now,
        )
        val body = buildJsonObject {
            put("title", title)
            notes?.let { put("notes", it) }
            put("project_id", projectId.json())
            put("task_type", draft.task_type)
            due?.let { put("due_date", it.toString()) }
        }
        mutate(PendingOp.Create(draft.id, body)) { it.upsert(draft) }
    }

    private suspend fun patch(id: String, body: JsonObject, local: (Task) -> Task) {
        val before = _workspace.value.task(id) ?: return
        mutate(PendingOp.Patch(id, body)) { it.replace(local(before)) }
    }

    /** Applies [local] straight away, queues [op] when connected (sample mode stops here), and tries to send it. */
    private suspend fun mutate(op: PendingOp, local: (Workspace) -> Workspace) {
        ensureLoaded()
        publish(local(_workspace.value))
        if (api == null) return
        updateQueue { it + op }
        if (flush() && resyncNeeded) {
            resyncNeeded = false
            refresh()
        }
    }

    @Volatile private var resyncNeeded = false

    /**
     * Sends queued ops in order. Returns true once the queue is empty; false if it stopped on a
     * network failure (ops stay queued) or because the source changed underneath it.
     */
    private suspend fun flush(): Boolean = writeLock.withLock {
        val api = api ?: return@withLock true
        val gen = generation
        while (true) {
            if (gen != generation) return@withLock false
            val op = _queue.value.firstOrNull() ?: break
            if (op.isOrphaned()) { dropHead(); continue }
            try {
                execute(api, op, gen)
                if (gen != generation) return@withLock false
                dropHead()
            } catch (e: IOException) {
                if (gen != generation) return@withLock false
                if (e.isTransient()) {
                    val waiting = _queue.value.size
                    _sync.value = SyncStatus.Failed("${e.friendly()} ${if (waiting == 1) "1 change" else "$waiting changes"} will sync later.")
                    return@withLock false
                }
                // Refused for good: forget it and re-sync so the screen stops showing it.
                dropHead()
                resyncNeeded = true
                _messages.tryEmit(e.friendly())
            }
        }
        true
    }

    /** An op aimed at a task created offline whose create was refused: nothing to apply it to. */
    private fun PendingOp.isOrphaned(): Boolean = when (this) {
        is PendingOp.Create -> false
        is PendingOp.Patch -> taskId.startsWith(LOCAL_ID_PREFIX)
        is PendingOp.Complete -> taskId.startsWith(LOCAL_ID_PREFIX)
        is PendingOp.Reopen -> taskId.startsWith(LOCAL_ID_PREFIX)
        is PendingOp.Delete -> taskId.startsWith(LOCAL_ID_PREFIX)
    }

    /** Runs one op and folds the server's answer into the workspace (unless the source changed). */
    private suspend fun execute(api: AlongsideApi, op: PendingOp, gen: Int) {
        fun apply(change: (Workspace) -> Workspace) {
            if (gen == generation) publish(change(_workspace.value))
        }
        when (op) {
            is PendingOp.Create -> {
                val row = api.createTask(op.body)
                apply { it.remove(op.localId).upsert(row) }
                if (gen == generation) updateQueue { ops -> ops.map { it.withTaskId(op.localId, row.id) } }
            }
            is PendingOp.Patch -> {
                val row = api.updateTask(op.taskId, op.body)
                apply { it.replace(row) }
            }
            is PendingOp.Complete -> {
                val result = api.completeTask(op.taskId)
                result.next?.let { next ->
                    synchronized(spawned) { spawned[op.taskId] = next.id }
                    // An undo queued while offline didn't know the successor; give it the id so
                    // replaying it deletes the copy this completion just spawned.
                    if (gen == generation) updateQueue { ops ->
                        ops.map { if (it is PendingOp.Reopen && it.taskId == op.taskId && it.spawnedId == null) it.copy(spawnedId = next.id) else it }
                    }
                }
                apply { ws -> ws.replace(result.completed).let { w -> result.next?.let(w::upsert) ?: w } }
            }
            is PendingOp.Reopen -> {
                if (op.spawnedId != null) ignoreMissing { api.deleteTask(op.spawnedId) }
                val row = api.updateTask(op.taskId, buildJsonObject { put("status", "pending") })
                apply { ws -> ws.replace(row).let { if (op.spawnedId != null) it.remove(op.spawnedId) else it } }
            }
            is PendingOp.Delete -> {
                ignoreMissing { api.deleteTask(op.taskId) }
                apply { it.remove(op.taskId) }
            }
        }
    }

    /** Deleting something already gone is a success. */
    private suspend fun ignoreMissing(block: suspend () -> Unit) {
        try { block() } catch (e: ApiException) { if (e.status != 404) throw e }
    }

    private fun PendingOp.withTaskId(from: String, to: String): PendingOp = when (this) {
        is PendingOp.Create -> this
        is PendingOp.Patch -> if (taskId == from) copy(taskId = to) else this
        is PendingOp.Complete -> if (taskId == from) copy(taskId = to) else this
        is PendingOp.Reopen -> if (taskId == from) copy(taskId = to) else this
        is PendingOp.Delete -> if (taskId == from) copy(taskId = to) else this
    }

    private fun dropHead() = updateQueue { it.drop(1) }

    /** Appends from [mutate] and drops from [flush] can interleave, so every change goes through one lock. */
    private fun updateQueue(change: (List<PendingOp>) -> List<PendingOp>) = synchronized(queueLock) {
        val ops = change(_queue.value)
        _queue.value = ops
        writeAtomically(queueFile, AlongsideApi.json.encodeToString(opsSerializer, ops))
    }

    private fun publish(ws: Workspace) {
        _workspace.value = ws
        cacheWrites.trySend(ws)
    }

    /** Writes the cache in publication order, keeping only the latest pending snapshot. */
    private fun startCacheWriter() = scope.launch(Dispatchers.IO) {
        for (ws in cacheWrites) {
            writeAtomically(cacheFile, AlongsideApi.json.encodeToString(Workspace.serializer(), ws))
            AlongsideWidgets.updateAll(context)
        }
    }

    /** Write to a sibling temp file, then rename over the target, so a reader never sees half a file. */
    private fun writeAtomically(target: File, text: String) {
        runCatching {
            val temp = File(target.parentFile, target.name + ".tmp")
            temp.writeText(text)
            if (!temp.renameTo(target)) {
                target.delete()
                temp.renameTo(target)
            }
        }
    }

    private fun IOException.friendly(): String = when (this) {
        is ApiException -> message ?: "Something went wrong."
        is java.net.UnknownHostException, is java.net.ConnectException -> "Can't reach the server."
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
