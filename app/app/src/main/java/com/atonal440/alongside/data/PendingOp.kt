package com.atonal440.alongside.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import java.security.SecureRandom

/**
 * A write the worker hasn't confirmed yet. Ops are stored on disk in order and replayed until
 * the server either accepts them or refuses them for good, so a change made offline survives
 * restarts instead of being overwritten by the next pull.
 *
 * Every op can also [applyLocally], which is how the screen shows it before the server answers,
 * and how ops still waiting are laid back over each server reply so an earlier answer never
 * undoes a later change.
 */
@Serializable
sealed interface PendingOp {
    val taskId: String

    fun applyLocally(ws: Workspace, now: String): Workspace

    /**
     * Created through the reliable `task.create` command: [taskId] and [commandId] are minted on
     * the phone, so a retry after a lost response replays the original result instead of making a
     * second task. [sent] is the exact envelope of the first attempt, resent on every retry.
     * Project and due date go in a follow-up legacy PATCH, which is safe to repeat.
     */
    @Serializable @SerialName("create")
    data class Create(
        override val taskId: String,
        val commandId: String,
        val title: String,
        val notes: String?,
        val taskType: String,
        val projectId: String?,
        val dueDate: String?,
        val sent: JsonObject? = null,
    ) : PendingOp {
        override fun applyLocally(ws: Workspace, now: String): Workspace {
            if (ws.task(taskId) != null) return ws
            return ws.upsert(
                Task(
                    id = taskId, title = title, notes = notes, task_type = taskType, project_id = projectId,
                    due_date = dueDate?.let { "${it}T12:00:00Z" }, due_all_day = dueDate?.let { true },
                    created_at = now, updated_at = now,
                ),
            )
        }
    }

    /** A legacy partial update; [body] holds only the fields it changes. */
    @Serializable @SerialName("patch")
    data class Patch(override val taskId: String, val body: JsonObject) : PendingOp {
        override fun applyLocally(ws: Workspace, now: String): Workspace {
            val task = ws.task(taskId) ?: return ws
            fun text(key: String, current: String?) =
                if (key in body) (body[key] as? JsonPrimitive)?.takeUnless { it is JsonNull }?.contentOrNull else current
            return ws.replace(
                task.copy(
                    focused_until = text("focused_until", task.focused_until),
                    defer_kind = text("defer_kind", task.defer_kind) ?: task.defer_kind,
                    defer_until = text("defer_until", task.defer_until),
                    status = text("status", task.status) ?: task.status,
                    project_id = text("project_id", task.project_id),
                    updated_at = now,
                ),
            )
        }
    }

    /**
     * Completed through the reliable `task.complete` command. For a repeating task the successor's
     * id is minted when the person taps complete, so the undo queued behind it knows exactly which
     * copy to delete, and a retry after a lost response replays the original result (same
     * successor) instead of being refused because the task is already done.
     */
    @Serializable @SerialName("complete")
    data class Complete(
        override val taskId: String,
        val commandId: String,
        val successorId: String?,
        val sent: JsonObject? = null,
    ) : PendingOp {
        override fun applyLocally(ws: Workspace, now: String): Workspace {
            val task = ws.task(taskId) ?: return ws
            return ws.replace(task.copy(status = "done", focused_until = null, updated_at = now))
        }
    }

    @Serializable @SerialName("reopen")
    data class Reopen(override val taskId: String, val spawnedId: String?) : PendingOp {
        override fun applyLocally(ws: Workspace, now: String): Workspace {
            val reopened = ws.task(taskId)?.let { ws.replace(it.copy(status = "pending", updated_at = now)) } ?: ws
            return if (spawnedId != null) reopened.remove(spawnedId) else reopened
        }
    }

    @Serializable @SerialName("delete")
    data class Delete(override val taskId: String) : PendingOp {
        override fun applyLocally(ws: Workspace, now: String) = ws.remove(taskId)
    }
}

/** The reliable command id of a create or complete; legacy ops have none. */
val PendingOp.commandId: String?
    get() = when (this) {
        is PendingOp.Create -> commandId
        is PendingOp.Complete -> commandId
        else -> null
    }

/** Network trouble and server hiccups are worth retrying; a 4xx refusal is final. */
fun Throwable.isTransient(): Boolean = when (this) {
    is ApiException -> status >= 500 || status == 408 || status == 429
    else -> true
}

private val random = SecureRandom()
private const val ID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

/** A prefixed id in the worker's shape (`t_…`, `c_…`: 5–64 of `[0-9A-Za-z_-]`). */
fun mintId(prefix: String, length: Int = 16): String =
    prefix + "_" + (1..length).map { ID_CHARS[random.nextInt(ID_CHARS.length)] }.joinToString("")
