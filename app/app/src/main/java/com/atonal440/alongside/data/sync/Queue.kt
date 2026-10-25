package com.atonal440.alongside.data.sync

import com.atonal440.alongside.data.Task
import com.atonal440.alongside.data.TaskLink
import com.atonal440.alongside.data.Workspace
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/**
 * A command the server has not confirmed. [base] is the revision of the written identity the
 * command was made against (null: it must not exist yet), [sent] the exact envelope once a send
 * was attempted, so a retry after a lost response replays the same payload under the same
 * [commandId] and the server answers from its receipt instead of applying it twice.
 */
@Serializable
data class QueuedOp(
    val id: Long,
    val commandId: String,
    val intent: Intent,
    val base: Long?,
    val createdAt: String,
    val sent: JsonObject? = null,
    val attempts: Int = 0,
)

/** Why a command left the queue without being applied. */
@Serializable
sealed interface RetainedReason {
    val message: String

    /** The server refused it for good (4xx other than auth, rate limit and upgrade). */
    @Serializable @SerialName("rejected")
    data class Rejected(val status: Int, override val message: String) : RetainedReason

    /** Someone wrote the identity since this was made; [currentRevision] is what the server holds now. */
    @Serializable @SerialName("conflict")
    data class Conflict(val status: Int, override val message: String, val currentRevision: Long?) : RetainedReason

    /** Not sent because the create it depends on was refused. */
    @Serializable @SerialName("dependency")
    data class Dependency(val dependsOn: String, override val message: String) : RetainedReason
}

/** A refused command kept so the person's intent is not lost: retried as a new command, or discarded. */
@Serializable
data class RetainedOp(val id: Long, val op: QueuedOp, val reason: RetainedReason)

/**
 * Everything the phone must not lose, in one file so a change of state is one atomic write: the
 * ordered queue, the commands the server applied that the canonical copy has not absorbed yet
 * ([landed]) and the refused ones. [source] is the server it belongs to.
 */
@Serializable
data class SyncState(
    val source: String = "",
    val nextId: Long = 1,
    val queue: List<QueuedOp> = emptyList(),
    val landed: List<QueuedOp> = emptyList(),
    /**
     * The canonical cursor when the first [landed] command landed. The canonical file and this state
     * are separate writes, so after a crash between them the file may already include the landed
     * commands; a stored cursor beyond this one proves a pull has absorbed them.
     */
    val landedAt: SyncCursor? = null,
    val retained: List<RetainedOp> = emptyList(),
    val syncedAtMillis: Long? = null,
)

/**
 * The revision a new command should be guarded against: the canonical revision of the identity
 * (live or tombstone, null if never seen) advanced by each command ahead of it that writes it.
 * Every write advances an identity by exactly one and a create starts it at 1, so a later command
 * stays valid after the earlier ones flush; if another device wrote in between, the server sees a
 * different revision and reports a conflict, which is the point. [ahead] is the commands the
 * canonical copy does not reflect yet: landed, then queued.
 */
fun predictBase(canonical: CanonicalWorkspace?, ahead: List<QueuedOp>, identity: String): Long? {
    var revision = canonical?.revision(identity)
    for (op in ahead) if (identity in op.intent.writes) revision = (revision ?: 0) + 1
    return revision
}

enum class SkipReason { TaskMissing, TaskExists, Invalid }

/** The canonical workspace with the ordered queue replayed on top, plus what became of each op. */
class OverlayView(val workspace: Workspace, val outcomes: List<SkipReason?>)

/**
 * What the screen shows: pure and total. The canonical copy and queue are never mutated, and an
 * op that no longer applies (task gone, duplicate create, a delete the worker would refuse) is
 * reported in [OverlayView.outcomes] and skipped while later ops still run. That the op stays
 * queued is the point: the server decides, and a refusal is retained for review.
 */
fun overlay(base: CanonicalView?, ops: List<QueuedOp>, syncedAtMillis: Long?): OverlayView {
    val tasks = LinkedHashMap<String, Task>()
    base?.tasks?.forEach { tasks[it.id] = it }
    val links = LinkedHashMap<String, TaskLink>()
    base?.links?.forEach { links[linkKey(it.from_task_id, it.to_task_id, it.link_type)] = it }

    fun hasSubtasks(id: String) = tasks.values.any { it.parent_id == id }
    fun hasOpenSubtasks(id: String) = tasks.values.any { it.parent_id == id && it.status == "pending" }

    val outcomes = ops.map { op ->
        val intent = op.intent
        val at = op.createdAt
        when (intent) {
            is Intent.Create -> {
                if (intent.taskId in tasks) return@map SkipReason.TaskExists
                tasks[intent.taskId] = Task(
                    id = intent.taskId, title = intent.title, notes = intent.notes, task_type = intent.taskType,
                    created_at = at, updated_at = at,
                )
                null
            }
            is Intent.Delete -> {
                if (intent.taskId !in tasks) return@map SkipReason.TaskMissing
                if (hasSubtasks(intent.taskId)) return@map SkipReason.Invalid
                tasks.remove(intent.taskId)
                links.values.removeAll { it.from_task_id == intent.taskId || it.to_task_id == intent.taskId }
                null
            }
            else -> {
                val task = tasks[intent.taskId] ?: return@map SkipReason.TaskMissing
                if (intent is Intent.Complete && hasOpenSubtasks(intent.taskId)) return@map SkipReason.Invalid
                tasks[intent.taskId] = intent.apply(task, at)
                null
            }
        }
    }
    return OverlayView(Workspace(tasks.values.toList(), base?.projects.orEmpty(), links.values.toList(), syncedAtMillis), outcomes)
}
