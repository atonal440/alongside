package com.atonal440.alongside.data.sync

import com.atonal440.alongside.data.AlongsideApi
import com.atonal440.alongside.data.ApiException
import com.atonal440.alongside.data.Task
import com.atonal440.alongside.data.Workspace
import com.atonal440.alongside.domain.toWire
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonObject
import java.io.IOException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.time.Instant
import java.util.concurrent.atomic.AtomicBoolean

sealed interface SyncStatus {
    data object Idle : SyncStatus
    data object Syncing : SyncStatus
    data class Failed(val message: String) : SyncStatus
}

/** The server calls the sync engine makes; [AlongsideApi] is the real one. Errors are [IOException]s. */
interface SyncApi {
    suspend fun snapshot(): JsonObject
    suspend fun delta(cursor: SyncCursor, watermark: SyncCursor?, limit: Int): JsonObject
    /** `POST /api/v2/entity`: the row, its version and the workspace structural revision. */
    suspend fun entity(entity: String, id: String): JsonObject
    suspend fun applyChanges(envelope: JsonObject)
}

/** After this many failed sends of one command the person is told it is not getting through. */
const val ATTEMPTS_CAP = 25
private const val PAGE_LIMIT = 500
/** Bound a pull so a misbehaving server cannot hold the client in an endless continuation. */
private const val MAX_PAGES = 1_000
private const val STRUCTURAL_CONFLICT = "structural_conflict"
private const val REVISION_CONFLICT = "revision_conflict"

/**
 * The phone's port of the PWA's sync engine (docs/pwa/sync/canonical-workspace.md): local-first,
 * with the same three pieces.
 *
 *  - **Canonical workspace.** What the server last committed, read by snapshot plus fixed-watermark
 *    deltas ([pull]). The only thing a pull writes.
 *  - **Command queue.** Every user write is queued as a guarded v2 command ([commit]) and sent in
 *    order by [flush]. Success drops it; a durable refusal retains it for review; a network error,
 *    5xx, auth or rate-limit failure keeps it queued and stops the flush, so order is preserved.
 *  - **View.** Canonical workspace with the queue replayed on top ([overlay]), republished on every
 *    change. A refused write vanishes from it because it left the queue; an offline write survives
 *    every refresh because its command is replayed.
 *
 * Switching server, token or sample mode calls [reset], which bumps a generation counter; work in
 * flight from the old source checks it before touching state and gives up if it moved.
 */
class SyncEngine(
    private val store: SyncStore,
    private val apiFactory: () -> SyncApi?,
    private val now: () -> Instant = Instant::now,
    private val io: CoroutineDispatcher = Dispatchers.IO,
) {
    private val lock = Any()
    @Volatile private var generation = 0
    private var loaded = false
    private var source = ""
    private var canonical: CanonicalWorkspace? = null
    private var state = SyncState()
    private var storageWarned = false
    private var stuckNoticeFired = false

    private val syncMutex = Mutex()
    private val syncRequested = AtomicBoolean(false)

    private val _workspace = MutableStateFlow(Workspace())
    /** What the screen shows: the canonical workspace with every unconfirmed command replayed. */
    val workspace: StateFlow<Workspace> = _workspace.asStateFlow()

    private val _retained = MutableStateFlow<List<RetainedOp>>(emptyList())
    /** Commands the server refused, kept so they can be retried as new commands or discarded. */
    val retained: StateFlow<List<RetainedOp>> = _retained.asStateFlow()

    private val _status = MutableStateFlow<SyncStatus>(SyncStatus.Idle)
    val status: StateFlow<SyncStatus> = _status.asStateFlow()

    private val _messages = MutableSharedFlow<String>(extraBufferCapacity = 8)
    val messages: SharedFlow<String> = _messages

    val hasPendingWrites: Boolean get() = state.queue.isNotEmpty()

    /** Loads the stored state for [newSource] once. [sample], when given, replaces the canonical copy (sample mode). */
    suspend fun load(newSource: String, sample: Workspace? = null) {
        if (loaded) return
        withContext(io) {
            synchronized(lock) {
                if (loaded) return@withContext
                source = newSource
                val saved = store.loadState()
                if (saved != null && saved.source != newSource) store.clear()
                state = saved?.takeIf { it.source == newSource } ?: SyncState(source = newSource)
                canonical = if (sample != null) canonicalFromWorkspace(sample) else readCanonical(newSource)
                loaded = true
                publish()
            }
        }
    }

    /** Drops everything stored for the old source; in-flight work from it gives up. */
    suspend fun reset(newSource: String, sample: Workspace? = null) = withContext(io) {
        synchronized(lock) {
            generation++
            runCatching { store.clear() }
            source = newSource
            state = SyncState(source = newSource)
            canonical = sample?.let(::canonicalFromWorkspace)
            loaded = true
            _status.value = SyncStatus.Idle
            publish()
        }
    }

    // ---- Writes ------------------------------------------------------------------------------

    /**
     * Queues [intents] in order and shows their effect straight away; sending is [sync]'s job. Each
     * command is guarded by the revision it was made against, predicted from the canonical copy
     * plus the commands ahead of it, so a change made elsewhere meanwhile surfaces as a conflict
     * instead of being overwritten.
     */
    suspend fun commit(intents: List<Intent>) {
        if (intents.isEmpty()) return
        withContext(io) {
            synchronized(lock) {
                val at = now().toWire()
                var next = state
                for (intent in intents) {
                    val base = if (intent is Intent.Create) null else predictBase(canonical, next.landed + next.queue, intent.writes[0])
                    next = next.copy(nextId = next.nextId + 1, queue = next.queue + QueuedOp(next.nextId, mintId("c"), intent, base, at))
                }
                state = next
                persistState()
                publish()
            }
        }
    }

    /** Put refused commands back at the end of the queue as new commands, rebased on the workspace as it is now. */
    suspend fun retryRetained(ids: Collection<Long>) = withContext(io) {
        synchronized(lock) {
            val chosen = state.retained.filter { it.id in ids }.sortedBy { it.id }
            if (chosen.isEmpty()) return@withContext
            val at = now().toWire()
            var next = state
            for (r in chosen) {
                val intent = r.op.intent
                val base = if (intent is Intent.Create) null else predictBase(canonical, next.landed + next.queue, intent.writes[0])
                next = next.copy(nextId = next.nextId + 1, queue = next.queue + QueuedOp(next.nextId, mintId("c"), intent, base, at))
            }
            state = next.copy(retained = next.retained.filterNot { it.id in ids })
            persistState()
            publish()
        }
    }

    /** Forget refused commands; the screen already shows the server's version. */
    suspend fun discardRetained(ids: Collection<Long>) = withContext(io) {
        synchronized(lock) {
            state = state.copy(retained = state.retained.filterNot { it.id in ids })
            persistState()
            publish()
        }
    }

    // ---- Sync --------------------------------------------------------------------------------

    /**
     * Sends the queue, then brings the canonical copy current. Single-flight: a call made while a
     * cycle is running asks for one more pass and returns once it has been served, so a write
     * queued mid-cycle is still sent.
     */
    suspend fun sync() {
        syncRequested.set(true)
        while (syncRequested.get()) {
            syncMutex.withLock { while (syncRequested.getAndSet(false)) cycle() }
        }
    }

    private suspend fun cycle() {
        val api = apiFactory() ?: return
        val gen = generation
        _status.value = SyncStatus.Syncing
        val halt = flush(api, gen)
        if (gen != generation) return
        // With the server unreachable a pull would only wait out the same timeout.
        val pullError = if (halt != null && !halt.reachable) null else pull(api, gen)
        if (gen != generation) return
        _status.value = when {
            halt != null -> {
                val waiting = state.queue.size
                SyncStatus.Failed("${halt.message} ${if (waiting == 1) "1 change" else "$waiting changes"} will sync later.")
            }
            pullError != null -> SyncStatus.Failed(pullError)
            else -> SyncStatus.Idle
        }
    }

    private class Halt(val message: String, val reachable: Boolean)

    private sealed interface Sent {
        data object Applied : Sent
        class Refused(val status: Int, val code: String?, val message: String, val currentRevision: Long?) : Sent
        class Transient(val message: String, val reachable: Boolean) : Sent
    }

    /** Sends queued commands in order. Returns why it stopped early, or null once the queue is empty. */
    private suspend fun flush(api: SyncApi, gen: Int): Halt? {
        while (true) {
            val op = synchronized(lock) { if (gen != generation) return null; state.queue.firstOrNull() } ?: return null
            when (val sent = send(api, op, gen)) {
                Sent.Applied -> {
                    // Held in `landed` until a pull has absorbed it, so the view and the revisions
                    // predicted for later writes keep counting it.
                    if (!update(gen, republish = false) { s -> s.copy(queue = s.queue.filterNot { it.id == op.id }, landed = s.landed + op) }) return null
                }
                is Sent.Refused -> if (!retain(op, sent, gen)) return null
                is Sent.Transient -> {
                    update(gen, republish = false) { s -> s.copy(queue = s.queue.map { if (it.id == op.id) it.copy(attempts = it.attempts + 1) else it }) }
                    if (op.attempts + 1 >= ATTEMPTS_CAP && !stuckNoticeFired) {
                        stuckNoticeFired = true
                        _messages.tryEmit("Some changes aren't syncing — they may need to be redone.")
                    }
                    return Halt(sent.message, sent.reachable)
                }
            }
        }
    }

    /**
     * Send one command. The envelope is built once, from the server's current row and aggregate
     * revision, and saved on the op before the first send; every retry (a lost response, a
     * transient failure) resends exactly that payload under the same command id, so the server
     * replays the original result instead of applying it twice. Only a structural-guard conflict,
     * which proves nothing was applied, discards it and builds again, once.
     */
    private suspend fun send(api: SyncApi, initial: QueuedOp, gen: Int): Sent {
        var op = initial
        try {
            for (attempt in 0..1) {
                // A previously sent envelope is only trusted if it is still this command's.
                var envelope = if (attempt == 0) op.sent?.takeIf { it.str("commandId") == op.commandId } else null
                if (envelope == null) {
                    envelope = buildFresh(api, op)
                    op = op.copy(sent = envelope)
                    update(gen, republish = false) { s -> s.replace(op) }
                }
                try {
                    api.applyChanges(envelope)
                    return Sent.Applied
                } catch (e: ApiException) {
                    if (e.code != STRUCTURAL_CONFLICT) throw e
                    op = op.copy(sent = null)
                    update(gen, republish = false) { s -> s.replace(op) }
                }
            }
            // Two structural conflicts in a row mean the graph is busy, not that the command is wrong.
            return Sent.Transient("The server is busy.", reachable = true)
        } catch (e: EnvelopeRefused) {
            return Sent.Refused(422, null, e.message.orEmpty(), null)
        } catch (e: ApiException) {
            return if (e.isDurable()) Sent.Refused(e.status, e.code, e.message.orEmpty(), e.currentRevision) else Sent.Transient(e.friendly(), reachable = true)
        } catch (e: SyncContractException) {
            return Sent.Transient("The server sent something this app couldn't read.", reachable = true)
        } catch (e: IOException) {
            return Sent.Transient(e.friendly(), reachable = false)
        }
    }

    private suspend fun buildFresh(api: SyncApi, op: QueuedOp): JsonObject {
        val target = EntityRead.parse(api.entity("task", op.intent.taskId))
        val intent = op.intent
        val projectRevision = if (intent is Intent.SetProject && intent.projectId != null) EntityRead.parse(api.entity("project", intent.projectId)).revision else null
        return buildEnvelope(op, BuildContext(target.row, target.structuralRevision, projectRevision))
    }

    /** Move a refused command, and for a refused create the commands queued on its task, out of the queue. */
    private fun retain(op: QueuedOp, refused: Sent.Refused, gen: Int): Boolean {
        val reason = if (refused.code == REVISION_CONFLICT) RetainedReason.Conflict(refused.status, refused.message, refused.currentRevision)
        else RetainedReason.Rejected(refused.status, refused.message)
        val kept = update(gen) { s ->
            var id = s.nextId
            val retained = ArrayList(s.retained)
            retained += RetainedOp(id++, op, reason)
            var queue = s.queue.filterNot { it.id == op.id }
            val created = (op.intent as? Intent.Create)?.taskId
            if (created != null) {
                // The task will never exist on the server, so everything aimed at it would fail too.
                val (dependents, rest) = queue.partition { it.intent.references(created) }
                dependents.forEach { retained += RetainedOp(id++, it, RetainedReason.Dependency(created, "Not sent because the task it depends on was rejected.")) }
                queue = rest
            }
            s.copy(nextId = id, queue = queue, retained = retained)
        }
        if (kept) {
            _messages.tryEmit(
                if (reason is RetainedReason.Conflict) "Couldn't save “${op.intent.describe()}”: it changed somewhere else. It's in Settings."
                else "Couldn't save “${op.intent.describe()}”: ${refused.message} It's in Settings.",
            )
        }
        return kept
    }

    private class PullResult(val next: CanonicalWorkspace, val persist: Boolean)
    private class ResetRequired : Exception()

    /** Returns a message when the pull failed, null when the canonical copy is current. */
    private suspend fun pull(api: SyncApi, gen: Int): String? = try {
        val base = synchronized(lock) { canonical }
        val result = if (base == null) bootstrap(api) else try {
            catchUp(api, base)
        } catch (e: ResetRequired) {
            bootstrap(api)
        }
        // A bootstrap or a change to something the app keeps is written out; a cursor that only
        // moved past entities it drops is not worth rewriting the file for (a replay is harmless).
        if (result.persist && gen == generation) withContext(io) { store.saveCanonical(CanonicalFile(source, result.next.cursor, result.next.images.values.toList())) }
        synchronized(lock) {
            if (gen == generation) {
                canonical = result.next
                state = state.copy(landed = emptyList(), syncedAtMillis = now().toEpochMilli())
                persistState()
                publish()
            }
        }
        null
    } catch (e: SyncContractException) {
        e.message
    } catch (e: IOException) {
        e.friendly()
    }

    private suspend fun bootstrap(api: SyncApi): PullResult =
        PullResult(canonicalFromSnapshot(SyncWire.snapshot(api.snapshot())), persist = true)

    /**
     * Delta pages from the stored cursor, staged in memory and applied only as a whole. A reset
     * from the server, a backlog past the page bound or a pull that fails reconciliation falls
     * back to one fresh snapshot ([ResetRequired]); anything else is the caller's to retry.
     */
    private suspend fun catchUp(api: SyncApi, base: CanonicalWorkspace): PullResult {
        val pages = ArrayList<DeltaPage>()
        var cursor = base.cursor
        while (pages.size < MAX_PAGES) {
            val raw = try {
                api.delta(cursor, pages.firstOrNull()?.watermark, PAGE_LIMIT)
            } catch (e: ApiException) {
                if (e.status == 409 && e.syncReset) throw ResetRequired()
                throw e
            }
            val page = SyncWire.delta(raw)
            val first = pages.firstOrNull()
            if (page.from != cursor || (first != null && page.watermark != first.watermark) || page.changes.size > PAGE_LIMIT) {
                throw SyncContractException("The server's reply doesn't match what was asked for.")
            }
            pages += page
            if (!page.hasMore) break
            cursor = page.cursor
        }
        // A backlog past the bound is cheaper to replace than to replay, and replaying again would never converge.
        if (pages.last().hasMore) throw ResetRequired()
        val next = try {
            applyStagedPull(base, pages)
        } catch (e: SyncContractException) {
            throw ResetRequired()
        }
        return PullResult(next, persist = pages.any { it.changes.isNotEmpty() })
    }

    // ---- State -------------------------------------------------------------------------------

    /** Change the state under the lock unless the source changed since [gen]. Returns false if it did. */
    private inline fun update(gen: Int, republish: Boolean = true, change: (SyncState) -> SyncState): Boolean = synchronized(lock) {
        if (gen != generation) return false
        state = change(state)
        persistState()
        if (republish) publish()
        true
    }

    private fun SyncState.replace(op: QueuedOp) = copy(queue = queue.map { if (it.id == op.id) op else it })

    private fun persistState() {
        try {
            store.saveState(state)
        } catch (e: IOException) {
            if (!storageWarned) {
                storageWarned = true
                _messages.tryEmit("Couldn't save changes on this phone. They may be lost if the app closes.")
            }
        }
    }

    /** Recompute what the screen shows from the canonical copy, the landed commands and the queue. */
    private fun publish() {
        val view = canonical?.let { runCatching { it.view }.getOrNull() }
        _workspace.value = overlay(view, state.landed + state.queue, state.syncedAtMillis).workspace
        _retained.value = state.retained
    }

    private fun readCanonical(source: String): CanonicalWorkspace? {
        val file = store.loadCanonical()?.takeIf { it.source == source } ?: return null
        return try {
            val images = file.images.associateBy { it.id }
            if (images.size != file.images.size || findDanglingReference(images.values) != null) return null
            CanonicalWorkspace(file.cursor, images).also { it.view }
        } catch (e: SerializationException) {
            null
        }
    }
}

/** What `POST /api/v2/entity` says about one entity. */
class EntityRead(val row: Task?, val revision: Long?, val structuralRevision: Long) {
    companion object {
        fun parse(json: JsonObject): EntityRead {
            val structural = json.long("structuralRevision") ?: throw SyncContractException("An entity read has no structural revision.")
            val revision = (json["version"] as? JsonObject)?.long("revision")
            val row = (json["row"] as? JsonObject)?.let {
                try {
                    AlongsideApi.json.decodeFromJsonElement(Task.serializer(), it)
                } catch (e: SerializationException) {
                    throw SyncContractException("An entity read has an unreadable row.")
                }
            }
            return EntityRead(row, revision, structural)
        }
    }
}

/**
 * Validation rejections (400/404/409/422) are durable: retrying cannot succeed without the person
 * changing the write. 401/403 (fix credentials), 408/429 (wait it out) and 426 (this build is too
 * old) are recoverable, and so are 5xx and unreadable replies.
 */
fun ApiException.isDurable(): Boolean = status in 400..499 && status !in setOf(401, 403, 408, 426, 429)

fun Throwable.friendly(): String = when (this) {
    is ApiException -> message ?: "Something went wrong."
    is UnknownHostException, is ConnectException -> "Can't reach the server."
    is SocketTimeoutException -> "The server took too long to answer."
    else -> message ?: "Something went wrong."
}
