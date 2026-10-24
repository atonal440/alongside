package com.atonal440.alongside.data

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull

/**
 * Wire shapes for the worker's REST API (docs/api.md). Field names match the
 * D1 columns in shared/schema.ts so rows round-trip without mapping.
 */
@Serializable
data class Task(
    val id: String,
    val title: String,
    val notes: String? = null,
    val status: String = "pending",
    val due_date: String? = null,
    @Serializable(with = LenientBooleanSerializer::class)
    val due_all_day: Boolean? = null,
    val recurrence: String? = null,
    val available_from: String? = null,
    val deadline: String? = null,
    val task_type: String = "action",
    val project_id: String? = null,
    val kickoff_note: String? = null,
    val session_log: String? = null,
    val defer_until: String? = null,
    val defer_kind: String = "none",
    val focused_until: String? = null,
    val duty_id: String? = null,
    val parent_id: String? = null,
    val position: Double? = null,
    val created_at: String = "",
    val updated_at: String = "",
) {
    val isDone get() = status == "done"
    val isPlan get() = task_type == "plan"
}

@Serializable
data class Project(
    val id: String,
    val title: String,
    val notes: String? = null,
    val kickoff_note: String? = null,
    val status: String = "active",
    val created_at: String = "",
    val updated_at: String = "",
) {
    val isActive get() = status == "active"
}

@Serializable
data class TaskLink(
    val from_task_id: String,
    val to_task_id: String,
    val link_type: String,
)

@Serializable
data class CompleteResult(val completed: Task, val next: Task? = null)

/** Everything the app shows, as last read from the worker (or the sample set). */
@Serializable
data class Workspace(
    val tasks: List<Task> = emptyList(),
    val projects: List<Project> = emptyList(),
    val links: List<TaskLink> = emptyList(),
    val syncedAtMillis: Long? = null,
) {
    fun task(id: String) = tasks.firstOrNull { it.id == id }
    fun project(id: String?) = id?.let { pid -> projects.firstOrNull { it.id == pid } }
    fun children(parentId: String) = tasks.filter { it.parent_id == parentId }
        .sortedWith(compareBy<Task, Double?>(nullsLast()) { it.position }.thenBy { it.created_at })

    fun replace(task: Task) = copy(tasks = tasks.map { if (it.id == task.id) task else it })
    fun upsert(task: Task) = if (tasks.any { it.id == task.id }) replace(task) else copy(tasks = tasks + task)
    fun remove(id: String) = copy(tasks = tasks.filterNot { it.id == id })
}

/** due_all_day is a boolean column, but older D1 reads can surface it as 0/1. */
object LenientBooleanSerializer : KSerializer<Boolean?> {
    override val descriptor = PrimitiveSerialDescriptor("LenientBoolean", PrimitiveKind.BOOLEAN)

    override fun deserialize(decoder: Decoder): Boolean? {
        val element = (decoder as? JsonDecoder)?.decodeJsonElement() ?: return decoder.decodeBoolean()
        if (element is JsonNull) return null
        val primitive = element as? JsonPrimitive ?: return null
        return primitive.booleanOrNull ?: primitive.intOrNull?.let { it != 0 }
    }

    @OptIn(ExperimentalSerializationApi::class)
    override fun serialize(encoder: Encoder, value: Boolean?) {
        if (value == null) encoder.encodeNull() else encoder.encodeBoolean(value)
    }
}
