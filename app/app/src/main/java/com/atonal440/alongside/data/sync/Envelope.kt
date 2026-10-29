package com.atonal440.alongside.data.sync

import com.atonal440.alongside.data.Task
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** What the server said about the target right before sending: its row, and the aggregate revision. */
class BuildContext(
    /** Current server row of the task the intent writes (null when it does not exist, as before a create). */
    val row: Task?,
    val structuralRevision: Long,
    /** Current revision of the project a task is being moved into, when relevant. */
    val projectRevision: Long?,
)

/** The change cannot be expressed as a command; it is retained as rejected rather than sent. */
class EnvelopeRefused(message: String) : Exception(message)

private fun String?.json() = this?.let { JsonPrimitive(it) } ?: JsonNull

/**
 * Turns a queued intent into the server's command envelope (`POST /api/v2/changes`), filling in
 * the guards at send time: the revision it was made against (`op.base`, the conflict signal), the
 * current aggregate revision (a graph change elsewhere should not fail an unrelated create) and,
 * for commands that replace several fields at once, the current row. Port of
 * `pwa/src/sync/envelope.ts`.
 */
fun buildEnvelope(op: QueuedOp, ctx: BuildContext): JsonObject {
    val intent = op.intent
    val structural = ctx.structuralRevision
    fun wrap(command: JsonObject) = buildJsonObject {
        put("contractVersion", 2)
        put("commandId", op.commandId)
        put("actor", "user")
        put("commands", buildJsonArray { add(command) })
    }
    if (intent is Intent.Create) {
        return wrap(buildJsonObject {
            put("kind", "task.create")
            put("id", intent.taskId)
            put("expectedRevision", JsonNull)
            put("expectedStructuralRevision", structural)
            put("values", buildJsonObject {
                put("title", intent.title)
                put("notes", intent.notes.json())
                put("kickoffNote", intent.kickoffNote.json())
                put("taskType", intent.taskType)
                put("project", JsonNull)
            })
        })
    }
    if (intent is Intent.Block) {
        // A link has no row of its own; a base of null means the link has never existed.
        return wrap(buildJsonObject {
            put("kind", "link.add"); put("from", intent.blockerId); put("to", intent.taskId); put("linkType", "blocks")
            put("expectedRevision", op.base)
            put("expectedStructuralRevision", structural)
        })
    }
    val base = op.base ?: throw EnvelopeRefused("This change has no base revision to guard against.")
    val row = ctx.row ?: throw EnvelopeRefused("That task no longer exists on the server.")
    val id = intent.taskId
    return wrap(
        when (intent) {
            is Intent.Create -> error("handled above")
            is Intent.SetProject -> buildJsonObject {
                put("kind", "task.project.set"); put("id", id); put("expectedRevision", base)
                put("expectedStructuralRevision", structural)
                put("project", intent.projectId?.let { pid ->
                    buildJsonObject { put("id", pid); put("expectedRevision", ctx.projectRevision ?: 0) }
                } ?: JsonNull)
            }
            is Intent.SetDue -> buildJsonObject {
                put("kind", "task.legacy-schedule.set"); put("id", id); put("expectedRevision", base)
                put("values", buildJsonObject {
                    put("dueDate", intent.dueDate)
                    put("dueAllDay", intent.dueAllDay)
                    put("recurrence", (if (intent.setsRecurrence) intent.recurrence else row.recurrence).json())
                })
            }
            is Intent.SetAvailableFrom -> buildJsonObject {
                put("kind", "task.dates.set"); put("id", id); put("expectedRevision", base)
                put("values", buildJsonObject {
                    put("availableFrom", intent.date?.let { d -> buildJsonObject { put("kind", "date"); put("date", d); put("timezone", intent.timezone) } } ?: JsonNull)
                    // The command replaces both dates; the deadline goes back as the server holds it (JSON text).
                    put("deadline", row.deadline?.let { text ->
                        runCatching { Json.parseToJsonElement(text) }.getOrNull() ?: throw EnvelopeRefused("The task's deadline couldn't be read, so its opening day wasn't changed.")
                    } ?: JsonNull)
                })
            }
            is Intent.Block -> error("handled above")
            is Intent.Defer -> buildJsonObject {
                put("kind", "task.defer.set"); put("id", id); put("expectedRevision", base)
                put("defer", buildJsonObject {
                    put("kind", intent.kind)
                    if (intent.kind == "until") put("until", intent.until ?: throw EnvelopeRefused("A nap needs a time to end."))
                })
            }
            is Intent.Focus -> buildJsonObject {
                put("kind", "task.focus.set"); put("id", id); put("expectedRevision", base)
                put("focusedUntil", intent.focusedUntil.json())
            }
            is Intent.Reopen -> buildJsonObject { put("kind", "task.reopen"); put("id", id); put("expectedRevision", base) }
            is Intent.Complete -> buildJsonObject {
                put("kind", "task.complete"); put("id", id); put("expectedRevision", base)
                put("expectedStructuralRevision", structural)
                // The server's row decides whether a successor is due.
                put("successor", intent.successorId?.takeIf { row.recurrence != null }?.let { sid -> buildJsonObject { put("id", sid) } } ?: JsonNull)
            }
            is Intent.Delete -> buildJsonObject {
                put("kind", "task.delete"); put("id", id); put("expectedRevision", base)
                put("expectedStructuralRevision", structural)
            }
        },
    )
}
