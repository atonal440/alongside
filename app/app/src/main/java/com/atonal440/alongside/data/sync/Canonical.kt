package com.atonal440.alongside.data.sync

import com.atonal440.alongside.data.AlongsideApi
import com.atonal440.alongside.data.Project
import com.atonal440.alongside.data.Task
import com.atonal440.alongside.data.TaskLink
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull

/** A reply or stored image the app cannot trust; the caller falls back to a fresh snapshot. */
class SyncContractException(message: String) : Exception(message)

/** The position in the server's change log an image set is current through. */
@Serializable
data class SyncCursor(val epoch: Long, val sequence: Long)

/**
 * One versioned image of an entity identity (`task:t_…`, `link:["t_a","t_b","blocks"]`): a live
 * row, or a tombstone (`row == null`) that still carries the revision the next write is guarded by.
 */
@Serializable
data class SyncImage(
    val entity: String,
    val key: String,
    val revision: Long,
    val deletedAt: String? = null,
    val row: JsonObject? = null,
) {
    val id: String get() = identity(entity, key)
}

fun identity(entity: String, key: String) = "$entity:$key"
fun taskIdentity(id: String) = identity("task", id)

/** A link is keyed by its JSON tuple, the same spelling the worker stores. */
fun linkKey(from: String, to: String, type: String) = JsonArray(listOf(JsonPrimitive(from), JsonPrimitive(to), JsonPrimitive(type))).toString()

/**
 * Entities the app keeps. Planning settings, preferences, the action log and command audit are
 * never read here (and the last two only grow), so they are dropped on arrival; the sync cursor
 * still advances past them.
 */
private val KEPT = setOf("task", "project", "link", "duty")

/** The typed rows of a canonical workspace, decoded once per pull. */
class CanonicalView(val tasks: List<Task>, val projects: List<Project>, val links: List<TaskLink>)

/**
 * The server's last committed workspace as the phone knows it: one image per identity plus the
 * cursor they are current through. A pure cache of server state; optimistic local intent stays in
 * the write queue and is laid over it by [overlay].
 *
 * The structural revision is deliberately absent: the delta contract never refreshes it, so a
 * stored copy would be stale after the first write. It is read just before a structural command.
 */
class CanonicalWorkspace(val cursor: SyncCursor, val images: Map<String, SyncImage>) {
    val view: CanonicalView by lazy {
        val tasks = ArrayList<Task>()
        val projects = ArrayList<Project>()
        val links = ArrayList<TaskLink>()
        for (image in images.values) {
            val row = image.row ?: continue
            when (image.entity) {
                "task" -> tasks += AlongsideApi.json.decodeFromJsonElement(Task.serializer(), row)
                "project" -> projects += AlongsideApi.json.decodeFromJsonElement(Project.serializer(), row)
                "link" -> links += AlongsideApi.json.decodeFromJsonElement(TaskLink.serializer(), row)
            }
        }
        CanonicalView(tasks, projects, links)
    }

    fun revision(identity: String): Long? = images[identity]?.revision
}

class Snapshot(val cursor: SyncCursor, val images: List<SyncImage>)

class DeltaPage(val from: SyncCursor, val cursor: SyncCursor, val watermark: SyncCursor, val hasMore: Boolean, val changes: List<SyncImage>)

internal fun JsonObject.str(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
internal fun JsonObject.long(key: String): Long? = (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull

private fun bad(message: String): Nothing = throw SyncContractException(message)

/** Parsers for the sync snapshot and delta replies, strict about everything the engine depends on. */
object SyncWire {
    fun cursor(element: JsonElement?): SyncCursor {
        val obj = element as? JsonObject ?: bad("A sync cursor is missing.")
        val epoch = obj.long("epoch")
        val sequence = obj.long("sequence")
        if (epoch == null || sequence == null || epoch < 1 || sequence < 1) bad("A sync cursor is malformed.")
        return SyncCursor(epoch, sequence)
    }

    /** Null for an entity the app does not keep. */
    fun image(element: JsonElement): SyncImage? {
        val obj = element as? JsonObject ?: bad("A sync entity is not an object.")
        val entity = obj.str("entity") ?: bad("A sync entity has no kind.")
        if (entity !in KEPT) return null
        val key = obj.str("key") ?: bad("A $entity image has no key.")
        val revision = obj.long("revision")?.takeIf { it >= 1 } ?: bad("$entity:$key has no valid revision.")
        val deletedAt = obj.str("deletedAt")
        val row = when (val raw = obj["row"]) {
            null, JsonNull -> null
            is JsonObject -> raw
            else -> bad("$entity:$key has an unreadable row.")
        }
        if ((row == null) != (deletedAt != null)) bad("$entity:$key disagrees with itself about being deleted.")
        if (row != null) verifyRow(entity, key, row)
        return SyncImage(entity, key, revision, deletedAt, row)
    }

    private fun verifyRow(entity: String, key: String, row: JsonObject) {
        val matches = try {
            when (entity) {
                "task" -> AlongsideApi.json.decodeFromJsonElement(Task.serializer(), row).id == key
                "project" -> AlongsideApi.json.decodeFromJsonElement(Project.serializer(), row).id == key
                "duty" -> row.str("id") == key
                else -> AlongsideApi.json.decodeFromJsonElement(TaskLink.serializer(), row).let { linkKey(it.from_task_id, it.to_task_id, it.link_type) == key }
            }
        } catch (e: kotlinx.serialization.SerializationException) {
            false
        }
        if (!matches) bad("$entity:$key has a row that does not match its identity.")
    }

    fun snapshot(json: JsonObject): Snapshot {
        if (json.long("contractVersion") != 2L) bad("The snapshot is not a v2 contract reply.")
        val cursor = cursor(json["cursor"])
        val entities = json["entities"] as? JsonArray ?: bad("The snapshot has no entities.")
        val images = entities.mapNotNull(::image)
        if (images.map { it.id }.toSet().size != images.size) bad("The snapshot repeats an identity.")
        findDanglingReference(images)?.let { bad(it) }
        return Snapshot(cursor, images)
    }

    fun delta(json: JsonObject): DeltaPage {
        if (json.long("contractVersion") != 2L) bad("The delta is not a v2 contract reply.")
        val from = cursor(json["from"])
        val cursor = cursor(json["cursor"])
        val watermark = cursor(json["watermark"])
        val hasMore = (json["hasMore"] as? JsonPrimitive)?.takeIf { !it.isString }?.content?.toBooleanStrictOrNull() ?: bad("The delta does not say whether more follows.")
        val changes = json["changes"] as? JsonArray ?: bad("The delta has no changes.")
        if (from.epoch != cursor.epoch || from.epoch != watermark.epoch || from.sequence > cursor.sequence || cursor.sequence > watermark.sequence) {
            bad("The delta's cursors do not agree.")
        }
        var previous = from.sequence
        val images = ArrayList<SyncImage>()
        for (change in changes) {
            val obj = change as? JsonObject ?: bad("A delta change is not an object.")
            val sequence = obj.long("sequence") ?: bad("A delta change has no sequence.")
            if (sequence <= previous || sequence > cursor.sequence) bad("Delta sequences are out of order.")
            previous = sequence
            image(obj["entity"] ?: bad("A delta change has no entity."))?.let(images::add)
        }
        val consistent = if (hasMore) changes.isNotEmpty() && previous == cursor.sequence && cursor.sequence < watermark.sequence
        else cursor.sequence == watermark.sequence
        if (!consistent) bad("The delta's continuation does not agree with its cursors.")
        return DeltaPage(from, cursor, watermark, hasMore, images)
    }
}

/**
 * First live reference that does not resolve to a live entity, or null. Hierarchy shape (loops,
 * depth) is the worker's to enforce; the app only needs references to resolve.
 */
fun findDanglingReference(images: Collection<SyncImage>): String? {
    val live = images.filter { it.row != null }.mapTo(HashSet()) { it.id }
    fun has(entity: String, key: String?) = key == null || identity(entity, key) in live
    for (image in images) {
        val row = image.row ?: continue
        when (image.entity) {
            "task" -> {
                if (!has("project", row.str("project_id"))) return "Task ${image.key} references missing project ${row.str("project_id")}."
                if (!has("duty", row.str("duty_id"))) return "Task ${image.key} references missing duty ${row.str("duty_id")}."
                if (!has("task", row.str("parent_id"))) return "Task ${image.key} references missing parent ${row.str("parent_id")}."
            }
            "duty" -> if (!has("project", row.str("project_id"))) return "Duty ${image.key} references missing project ${row.str("project_id")}."
            "link" -> if (!has("task", row.str("from_task_id")) || !has("task", row.str("to_task_id"))) return "Link ${image.key} references a missing task."
        }
    }
    return null
}

fun canonicalFromSnapshot(snapshot: Snapshot) = CanonicalWorkspace(snapshot.cursor, snapshot.images.associateBy { it.id })

/**
 * Reconcile one complete staged delta pull. Pages may split a source transaction and temporarily
 * dangle references, so nothing is validated until every page is applied; the caller commits the
 * result whole or discards it.
 */
fun applyStagedPull(base: CanonicalWorkspace, pages: List<DeltaPage>): CanonicalWorkspace {
    val first = pages.firstOrNull() ?: bad("A pull needs at least one page.")
    if (pages.last().hasMore) bad("The pull ended before the fixed watermark.")
    var cursor = base.cursor
    val images = HashMap(base.images)
    for (page in pages) {
        if (page.from != cursor) bad("Delta pages must continue exactly from the previous cursor.")
        if (page.watermark != first.watermark) bad("The fixed watermark changed during the pull.")
        for (image in page.changes) {
            val known = images[image.id]
            if (known != null && image.revision <= known.revision) bad("${image.id} arrived at revision ${image.revision}, not above ${known.revision}.")
            images[image.id] = image
        }
        cursor = page.cursor
    }
    findDanglingReference(images.values)?.let { bad(it) }
    return CanonicalWorkspace(cursor, images)
}
