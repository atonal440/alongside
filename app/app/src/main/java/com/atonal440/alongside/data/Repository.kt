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
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.io.File
import java.io.IOException
import java.time.Instant
import java.time.LocalDate

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
    private val setAsideFile = File(context.filesDir, "set_aside_ops.json")
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

    /** Changes that kept failing with server errors, kept so they can be tried again or discarded. */
    private val _setAside = MutableStateFlow<List<PendingOp>>(emptyList())
    val setAside: StateFlow<List<PendingOp>> = _setAside.asStateFlow()

    private val _sync = MutableStateFlow<SyncStatus>(SyncStatus.Idle)
    val sync: StateFlow<SyncStatus> = _sync.asStateFlow()

    private val _messages = MutableSharedFlow<String>(extraBufferCapacity = 8)
    val messages: SharedFlow<String> = _messages

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
                val ops = runCatching { AlongsideApi.json.decodeFromString(opsSerializer, queueFile.readText()) }.getOrNull().orEmpty()
                _queue.value = ops
                _setAside.value = runCatching { AlongsideApi.json.decodeFromString(opsSerializer, setAsideFile.readText()) }.getOrNull().orEmpty()
                if (cached != null && _workspace.value.tasks.isEmpty()) {
                    // The queue is saved synchronously but the cache asynchronously, so the cache can
                    // be older than the queue after a crash; lay the waiting ops back over it.
                    val now = Clock.now().toWire()
                    _workspace.value = ops.fold(cached) { ws, op -> op.applyLocally(ws, now) }
                }
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
            updateSetAside { emptyList() }
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

    /** Marks a task done. Returns the id its next occurrence will have when it repeats. */
    suspend fun complete(id: String): String? {
        ensureLoaded()
        val task = _workspace.value.task(id) ?: return null
        val successorId = if (task.recurrence != null) mintId("t") else null
        mutate(PendingOp.Complete(id, mintId("c"), successorId))
        return successorId
    }

    /** Undo for [complete]: reopen the task and drop the successor it spawned, if any. */
    suspend fun reopen(id: String, spawnedId: String?) {
        mutate(PendingOp.Reopen(id, spawnedId))
    }

    suspend fun setFocus(id: String, focused: Boolean) {
        val until = if (focused) Clock.endOfToday().toWire() else null
        mutate(PendingOp.Patch(id, buildJsonObject { put("focused_until", until.json()) }))
    }

    /** Snoozes a task until [until], or to someday when null. */
    suspend fun nap(id: String, until: Instant?) {
        mutate(PendingOp.Patch(id, buildJsonObject {
            put("defer_kind", if (until == null) "someday" else "until")
            put("defer_until", until?.toWire().json())
            put("focused_until", JsonNull)
        }))
    }

    suspend fun wake(id: String) {
        mutate(PendingOp.Patch(id, buildJsonObject {
            put("defer_kind", "none")
            put("defer_until", JsonNull)
        }))
    }

    /**
     * Deletes a task. The worker refuses to delete a task that has subtasks (done or not), so
     * that is checked here first, as the PWA does, rather than queueing a delete that can't land.
     * Returns false when refused.
     */
    suspend fun delete(id: String): Boolean {
        ensureLoaded()
        if (hasSubtasks(id)) {
            _messages.tryEmit(SUBTASKS_BLOCK_DELETE)
            return false
        }
        mutate(PendingOp.Delete(id))
        return true
    }

    fun hasSubtasks(id: String) = _workspace.value.tasks.any { it.parent_id == id }

    suspend fun create(title: String, notes: String?, projectId: String?, plan: Boolean, due: LocalDate?) {
        mutate(
            PendingOp.Create(
                taskId = mintId("t"), commandId = mintId("c"), title = title, notes = notes,
                taskType = if (plan) "plan" else "action", projectId = projectId, dueDate = due?.toString(),
            ),
        )
    }

    /** Shows [op] straight away, queues it when connected (sample mode stops here), and tries to send it. */
    private suspend fun mutate(op: PendingOp) {
        ensureLoaded()
        if (_workspace.value.task(op.taskId) == null && op !is PendingOp.Create) return
        publish(op.applyLocally(_workspace.value, Clock.now().toWire()))
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
            try {
                execute(api, op, gen)
                if (gen != generation) return@withLock false
                dropHead()
            } catch (e: IOException) {
                if (gen != generation) return@withLock false
                if (e is ApiException && e.isTransient()) {
                    // The server answered with an error. Count it; after too many in a row, set the
                    // change aside so the writes behind it aren't blocked.
                    val head = _queue.value.firstOrNull() ?: op
                    val failures = head.serverFailures + 1
                    if (failures >= MAX_SERVER_FAILURES) {
                        // Later changes to the same task depend on this one (a patch after a create
                        // would 404 and be lost), so they go aside with it, in order. Other tasks'
                        // changes stay queued and keep going.
                        // One hold of the (reentrant) lock across collect and move, so a change queued
                        // for this task meanwhile can't be removed without being set aside.
                        synchronized(queueLock) {
                            val related = _queue.value.filter { it.taskId == head.taskId }
                            updateQueue { ops -> ops.filterNot { it.taskId == head.taskId } }
                            updateSetAside { it + related.map { o -> if (o == head) o.withServerFailures(failures) else o } }
                        }
                        val title = _workspace.value.task(op.taskId)?.title
                        _messages.tryEmit(
                            "Couldn't save ${title?.let { "a change to \u201c$it\u201d" } ?: "a change"} after $failures tries. " +
                                "It's set aside in Settings.",
                        )
                        if (!restoreFromServer(api, op.taskId, gen)) resyncNeeded = true
                        continue
                    }
                    updateQueue { ops -> if (ops.firstOrNull() == head) listOf(head.withServerFailures(failures)) + ops.drop(1) else ops }
                }
                if (e.isTransient()) {
                    val waiting = _queue.value.size
                    _sync.value = SyncStatus.Failed("${e.friendly()} ${if (waiting == 1) "1 change" else "$waiting changes"} will sync later.")
                    return@withLock false
                }
                // Refused for good: forget it and put the task back the way the server has it now,
                // so the screen stops showing the refused change even if a later op is stuck.
                dropHead()
                _messages.tryEmit(e.friendly())
                if (!restoreFromServer(api, op.taskId, gen)) resyncNeeded = true
            }
        }
        true
    }

    /**
     * Runs one op and folds the server's answer into the workspace (unless the source changed).
     * The ops still queued behind it are laid back over the answer, so replying to an earlier
     * change never undoes a later one that hasn't been sent yet.
     */
    private suspend fun execute(api: AlongsideApi, op: PendingOp, gen: Int) {
        fun apply(change: (Workspace) -> Workspace) {
            if (gen == generation) publishOverQueue(_queue.value.drop(1), change)
        }
        when (op) {
            is PendingOp.Create -> {
                sendCommand(api, op.taskId, op.sent, gen, save = { sent -> replaceQueued(op.copy(sent = sent)) }) { read ->
                    createEnvelope(op, read.structuralRevision)
                }
                if (op.projectId != null || op.dueDate != null) {
                    api.updateTask(op.taskId, buildJsonObject {
                        if (op.projectId != null) put("project_id", op.projectId)
                        if (op.dueDate != null) put("due_date", op.dueDate)
                    })
                }
                val row = api.task(op.taskId)
                apply { it.upsert(row) }
            }
            is PendingOp.Patch -> {
                val row = api.updateTask(op.taskId, op.body)
                apply { it.replace(row) }
            }
            is PendingOp.Complete -> {
                var successorId = op.successorId
                sendCommand(api, op.taskId, op.sent, gen, save = { sent -> replaceQueued(op.copy(successorId = successorId, sent = sent)) }) { read ->
                    val row = read.row ?: throw ApiException(404, "That task is gone from the server.")
                    val revision = read.revision ?: throw ApiException(404, "That task is gone from the server.")
                    // The server's row decides whether a successor is due; mint one if this phone didn't know it repeats.
                    if (row.recurrence != null && successorId == null) successorId = mintId("t")
                    completeEnvelope(op, revision, read.structuralRevision, successorId.takeIf { row.recurrence != null })
                }
                val completed = api.task(op.taskId)
                // Only a 404 means no successor was made. Any other failure keeps the completion
                // queued; its saved envelope replays safely and the read is tried again.
                val successor = successorId?.let { id ->
                    try { api.task(id) } catch (e: ApiException) { if (e.status == 404) null else throw e }
                }
                apply { ws -> ws.replace(completed).let { w -> successor?.let(w::upsert) ?: w } }
            }
            is PendingOp.Reopen -> {
                if (op.spawnedId != null) ignoreMissing { api.deleteTask(op.spawnedId) }
                val row = api.updateTask(op.taskId, buildJsonObject { put("status", "pending") })
                apply { ws -> ws.replace(row).let { if (op.spawnedId != null) it.remove(op.spawnedId) else it } }
            }
            is PendingOp.Delete -> {
                try {
                    ignoreMissing { api.deleteTask(op.taskId) }
                } catch (e: ApiException) {
                    // A subtask added elsewhere after this was queued makes the worker answer 5xx,
                    // which would otherwise be retried forever at the head of the queue.
                    if (e.status >= 500 && api.allTasks().any { it.parent_id == op.taskId }) {
                        throw ApiException(409, SUBTASKS_BLOCK_DELETE)
                    }
                    throw e
                }
                apply { it.remove(op.taskId) }
            }
        }
    }

    /** Put set-aside changes back at the end of the queue with a fresh count, and try them now. */
    suspend fun retrySetAside() {
        ensureLoaded()
        // One hold of the (reentrant) lock across collect, clear and requeue, so a change set aside
        // by a background flush meanwhile is neither erased nor left behind.
        val ops = synchronized(queueLock) {
            val ops = _setAside.value
            if (ops.isEmpty()) return
            updateSetAside { emptyList() }
            updateQueue { it + ops.map { op -> op.withServerFailures(0) } }
            ops
        }
        val now = Clock.now().toWire()
        publish(ops.fold(_workspace.value) { ws, op -> op.applyLocally(ws, now) })
        if (flush() && resyncNeeded) {
            resyncNeeded = false
            refresh()
        }
    }

    /**
     * Forget the set-aside changes the person was shown ([seen]); the screen already shows the
     * server's version. Anything set aside since then stays, so it isn't discarded unseen.
     */
    fun discardSetAside(seen: List<PendingOp>) {
        updateSetAside { ops -> ops.filterNot { it in seen } }
    }

    private fun updateSetAside(change: (List<PendingOp>) -> List<PendingOp>) = synchronized(queueLock) {
        val ops = change(_setAside.value)
        _setAside.value = ops
        writeAtomically(setAsideFile, AlongsideApi.json.encodeToString(opsSerializer, ops))
    }

    /** Apply [change] to the workspace, then lay the [waiting] ops back over it before publishing. */
    private fun publishOverQueue(waiting: List<PendingOp>, change: (Workspace) -> Workspace) {
        val now = Clock.now().toWire()
        publish(waiting.fold(change(_workspace.value)) { ws, later -> later.applyLocally(ws, now) })
    }

    /**
     * After a refusal, re-read the task and show the server's version under whatever is still
     * queued. Returns false when the read itself fails, so the caller falls back to a full re-sync.
     */
    private suspend fun restoreFromServer(api: AlongsideApi, taskId: String, gen: Int): Boolean {
        val row = try {
            api.task(taskId)
        } catch (e: ApiException) {
            if (e.status != 404) return false
            null
        } catch (e: IOException) {
            return false
        }
        if (gen == generation) publishOverQueue(_queue.value) { ws -> if (row != null) ws.upsert(row) else ws.remove(taskId) }
        return true
    }

    /**
     * Swap the queued op with [updated]'s command id for [updated] (to save its sent envelope).
     * Matching on the command id, not the task, keeps a second completion of the same task intact.
     */
    private fun replaceQueued(updated: PendingOp) = updateQueue { ops ->
        ops.map { if (it.commandId != null && it.commandId == updated.commandId) updated else it }
    }

    /**
     * Sends a reliable v2 command the way the PWA does: the envelope is built once from a fresh read,
     * saved into the queued op before the first send, and resent unchanged on every retry, so a lost
     * response replays the original result. Only a structural or revision conflict, which proves
     * nothing was applied, rebuilds it, once; a second in a row is treated as a busy server.
     */
    private suspend fun sendCommand(
        api: AlongsideApi,
        taskId: String,
        initialSent: JsonObject?,
        gen: Int,
        save: (JsonObject?) -> Unit,
        build: (AlongsideApi.TaskRead) -> JsonObject,
    ) {
        var sent = initialSent
        for (attempt in 0..1) {
            val envelope = sent ?: build(api.readTask(taskId)).also { built ->
                sent = built
                if (gen == generation) save(built)
            }
            try {
                api.applyChanges(envelope)
                return
            } catch (e: ApiException) {
                if (e.code != "structural_conflict" && e.code != "revision_conflict") throw e
                if (attempt == 1) throw ApiException(503, "The server is busy. Trying again later.")
                sent = null
            }
        }
    }

    private fun commandEnvelope(commandId: String, command: JsonObject) = buildJsonObject {
        put("contractVersion", 2)
        put("commandId", commandId)
        put("actor", "user")
        put("commands", buildJsonArray { add(command) })
    }

    private fun createEnvelope(op: PendingOp.Create, structuralRevision: Long) = commandEnvelope(op.commandId, buildJsonObject {
        put("kind", "task.create")
        put("id", op.taskId)
        put("expectedRevision", JsonNull)
        put("expectedStructuralRevision", structuralRevision)
        put("values", buildJsonObject {
            put("title", op.title)
            put("notes", op.notes.json())
            put("kickoffNote", JsonNull)
            put("taskType", op.taskType)
            put("project", JsonNull)
        })
    })

    private fun completeEnvelope(op: PendingOp.Complete, revision: Long, structuralRevision: Long, successorId: String?) =
        commandEnvelope(op.commandId, buildJsonObject {
            put("kind", "task.complete")
            put("id", op.taskId)
            put("expectedRevision", revision)
            put("expectedStructuralRevision", structuralRevision)
            put("successor", successorId?.let { id -> buildJsonObject { put("id", id) } } ?: JsonNull)
        })

    /** Deleting something already gone is a success. */
    private suspend fun ignoreMissing(block: suspend () -> Unit) {
        try { block() } catch (e: ApiException) { if (e.status != 404) throw e }
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
        /** Same wording as the PWA and the worker. */
        const val SUBTASKS_BLOCK_DELETE = "This task has subtasks; delete or detach them first."

        @Volatile private var instance: Repository? = null

        fun get(context: Context): Repository = instance ?: synchronized(this) {
            instance ?: Repository(context.applicationContext).also { instance = it }
        }
    }
}
