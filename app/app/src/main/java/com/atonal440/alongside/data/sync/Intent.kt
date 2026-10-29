package com.atonal440.alongside.data.sync

import com.atonal440.alongside.data.Task
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import java.security.SecureRandom

/**
 * What a queued command means, independent of when it is sent. Each intent maps to exactly one
 * server command (`shared/wire/commands.ts`); the envelope is built at send time from the server's
 * current row and structural revision ([buildEnvelope]). Like the PWA's intents, each writes one
 * identity, so a multi-field change is several independently guarded, independently reviewable
 * commands. The kinds mirror `pwa/src/sync/intent.ts`; the app adds the rest (content, type,
 * links) as it grows the screens that make them.
 */
@Serializable
sealed interface Intent {
    /** The task whose row, and the workspace's structural revision, the envelope is built from. */
    val taskId: String

    /** Identities this intent writes, the first being the one its `base` guards. */
    val writes: List<String> get() = listOf(taskIdentity(taskId))

    /** The task as the server leaves it after this intent, for the optimistic view. */
    fun apply(task: Task, at: String): Task = task

    fun describe(): String

    @Serializable @SerialName("task.create")
    data class Create(
        override val taskId: String,
        val title: String,
        val notes: String?,
        val taskType: String,
        val kickoffNote: String? = null,
    ) : Intent {
        override fun describe() = "Create “$title”"
    }

    @Serializable @SerialName("task.project")
    data class SetProject(override val taskId: String, val projectId: String?) : Intent {
        override fun apply(task: Task, at: String) = task.copy(project_id = projectId, updated_at = at)
        override fun describe() = "Move task to a project"
    }

    /** Sets the due date; the task's repeat rule is kept as the server has it. */
    @Serializable @SerialName("task.schedule")
    data class SetDue(override val taskId: String, val dueDate: String, val dueAllDay: Boolean) : Intent {
        override fun apply(task: Task, at: String) = task.copy(due_date = dueDate, due_all_day = dueAllDay, updated_at = at)
        override fun describe() = "Change due date"
    }

    /**
     * Sets (or clears, when [date] is null) the day the task opens: a local calendar date in [timezone], the
     * worker's `task.dates.set`. That command replaces availability and deadline together, so the envelope
     * carries the server's current deadline through unchanged.
     */
    @Serializable @SerialName("task.availability")
    data class SetAvailableFrom(override val taskId: String, val date: String?, val timezone: String) : Intent {
        override fun apply(task: Task, at: String) = task.copy(
            available_from = date?.let { """{"kind":"date","date":"$it","timezone":"$timezone"}""" }, updated_at = at,
        )
        override fun describe() = "Change when a task opens"
    }

    /**
     * Makes [blockerId] a prerequisite of [taskId] (`blocks` runs from the blocker to the task it holds back).
     * It writes the link's own identity, so its base is the link's revision: null for a link never seen, a
     * tombstone's revision for one that was removed.
     */
    @Serializable @SerialName("link.block")
    data class Block(override val taskId: String, val blockerId: String) : Intent {
        override val writes get() = listOf(identity("link", linkKey(blockerId, taskId, "blocks")))
        override fun describe() = "Mark a task as waiting on another"
    }

    /** [kind] is `none`, `someday` or `until`; deferring clears focus on the server, so it does here. */
    @Serializable @SerialName("task.defer")
    data class Defer(override val taskId: String, val kind: String, val until: String? = null) : Intent {
        override fun apply(task: Task, at: String) =
            task.copy(defer_kind = kind, defer_until = until.takeIf { kind == "until" }, focused_until = null, updated_at = at)
        override fun describe() = when (kind) {
            "none" -> "Wake a task"
            "someday" -> "Move a task to someday"
            else -> "Nap a task"
        }
    }

    /** Focusing clears a defer on the server; unfocusing ([focusedUntil] null) leaves it alone. */
    @Serializable @SerialName("task.focus")
    data class Focus(override val taskId: String, val focusedUntil: String?) : Intent {
        override fun apply(task: Task, at: String) = task.copy(
            focused_until = focusedUntil,
            defer_kind = if (focusedUntil != null) "none" else task.defer_kind,
            defer_until = if (focusedUntil != null) null else task.defer_until,
            updated_at = at,
        )
        override fun describe() = if (focusedUntil != null) "Focus a task" else "Unfocus a task"
    }

    /**
     * [spawnedId] is the successor an undo deletes first: the reopen is sent only if that delete
     * was accepted, so a refused delete never leaves both occurrences pending.
     */
    @Serializable @SerialName("task.reopen")
    data class Reopen(override val taskId: String, val spawnedId: String? = null) : Intent {
        override fun apply(task: Task, at: String) = task.copy(status = "pending", updated_at = at)
        override fun describe() = "Reopen a task"
    }

    /**
     * [successorId] is minted when the person taps complete and used only if the server's row
     * turns out to repeat, so an undo queued behind it can name exactly the copy to delete and a
     * retry after a lost response replays the same successor.
     */
    @Serializable @SerialName("task.complete")
    data class Complete(override val taskId: String, val successorId: String?) : Intent {
        override val writes get() = listOfNotNull(taskIdentity(taskId), successorId?.let(::taskIdentity))
        override fun apply(task: Task, at: String) =
            task.copy(status = "done", defer_kind = "none", defer_until = null, focused_until = null, updated_at = at)
        override fun describe() = "Complete a task"
    }

    @Serializable @SerialName("task.delete")
    data class Delete(override val taskId: String) : Intent {
        override fun describe() = "Delete a task"
    }
}

/** Does this intent touch [taskId] (as its target, or as the successor it will create)? */
fun Intent.references(taskId: String): Boolean =
    this.taskId == taskId || (this is Intent.Complete && successorId == taskId) || (this is Intent.Block && blockerId == taskId)

private val random = SecureRandom()
private const val ID_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"

/** A prefixed id in the worker's shape (`t_…`, `c_…`: 5–64 of `[0-9A-Za-z_-]`). */
fun mintId(prefix: String, length: Int = 16): String =
    prefix + "_" + (1..length).map { ID_CHARS[random.nextInt(ID_CHARS.length)] }.joinToString("")
