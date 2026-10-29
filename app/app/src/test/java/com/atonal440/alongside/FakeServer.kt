package com.atonal440.alongside

import com.atonal440.alongside.data.ApiException
import com.atonal440.alongside.data.sync.SyncApi
import com.atonal440.alongside.data.sync.SyncCursor
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import java.io.IOException

/** A small in-memory worker: revisions per identity, a change log, receipts and injectable failures. */
class FakeServer : SyncApi {
    // A fresh worker starts at epoch 0 and sequence 0, and revisions are valid from 0.
    var epoch = 0L
    var seq = 0L
    var structural = 1L
    private class Entry(var revision: Long, var row: JsonObject?)
    private val entries = LinkedHashMap<String, Entry>()
    private val log = ArrayList<Pair<Long, JsonObject>>()
    private val receipts = HashMap<String, JsonObject>()
    val applied = ArrayList<JsonObject>()
    var offline = false
    var loseNextResponse = false
    var resetNext = false
    var failNext: ApiException? = null
    /** The write commits, then the gateway answers with this instead of the worker's reply. */
    var failAfterApply: ApiException? = null
    var deltaRequests = 0
    var snapshotRequests = 0
    /** The graph moves right after the next entity read, so the envelope built from it is stale. */
    var bumpStructuralAfterRead = false

    fun taskRow(id: String, title: String = id, recurrence: String? = null, status: String = "pending") = buildJsonObject {
        put("id", id); put("title", title); put("notes", JsonNull); put("status", status)
        put("due_date", if (recurrence != null) JsonPrimitive("2026-10-25T12:00:00Z") else JsonNull)
        put("due_all_day", if (recurrence != null) JsonPrimitive(true) else JsonNull)
        put("recurrence", recurrence?.let { JsonPrimitive(it) } ?: JsonNull)
        put("created_at", "2026-10-01T00:00:00Z"); put("updated_at", "2026-10-01T00:00:00Z")
        put("defer_until", JsonNull); put("defer_kind", "none"); put("task_type", "action"); put("project_id", JsonNull)
        put("kickoff_note", JsonNull); put("session_log", JsonNull); put("focused_until", JsonNull)
        put("duty_id", JsonNull); put("parent_id", JsonNull); put("position", JsonNull)
    }

    private fun record(id: String, row: JsonObject?, entity: String = "task") {
        val e = entries.getOrPut("$entity:$id") { Entry(0, null) }
        e.revision += 1
        e.row = row
        seq += 1
        log += seq to image(entity, id, e)
    }

    fun dutyRow(id: String, title: String = id, rrule: String = "FREQ=DAILY", status: String = "active") = buildJsonObject {
        put("id", id); put("title", title); put("notes", JsonNull); put("kickoff_note", JsonNull); put("task_type", "action")
        put("project_id", JsonNull); put("rrule", rrule); put("dtstart", "2026-10-25T12:00:00Z"); put("timezone", JsonNull)
        put("status", status); put("catch_up", "next"); put("last_spawned_at", JsonNull)
        put("next_occurrence_at", if (status == "ended") JsonNull else JsonPrimitive("2026-10-25T12:00:00Z"))
        put("created_at", "2026-10-01T00:00:00Z"); put("updated_at", "2026-10-01T00:00:00Z")
    }

    /** Another device creates a series. */
    fun putDuty(id: String, title: String = id, rrule: String = "FREQ=DAILY", status: String = "active") = record(id, dutyRow(id, title, rrule, status), "duty")
    fun dutyRowOf(id: String) = entries["duty:$id"]?.row
    fun dutyRevision(id: String) = entries["duty:$id"]?.revision

    private fun image(entity: String, key: String, e: Entry) = buildJsonObject {
        put("entity", entity); put("key", key); put("revision", e.revision)
        put("deletedAt", if (e.row == null) JsonPrimitive("2026-10-24T00:00:00Z") else JsonNull)
        put("row", e.row ?: JsonNull)
    }

    /** Another device writes a task. */
    fun put(id: String, title: String = id, recurrence: String? = null) = record(id, taskRow(id, title, recurrence))
    fun edit(id: String, change: (JsonObject) -> JsonObject) = record(id, change(entries["task:$id"]!!.row!!))
    fun revision(id: String) = entries["task:$id"]?.revision
    fun row(id: String) = entries["task:$id"]?.row

    /** An entity the app drops arrives in the log. */
    fun noise() {
        seq += 1
        log += seq to buildJsonObject {
            put("entity", "action_log"); put("key", seq.toString()); put("revision", 1); put("deletedAt", JsonNull)
            put("row", buildJsonObject { put("id", seq) })
        }
    }

    private fun gate() {
        if (offline) throw IOException("offline")
        failNext?.let { failNext = null; throw it }
    }

    private fun cursor(s: Long) = buildJsonObject { put("epoch", epoch); put("sequence", s) }

    override suspend fun snapshot(): JsonObject {
        gate()
        snapshotRequests++
        return buildJsonObject {
            put("contractVersion", 2); put("cursor", cursor(seq)); put("structuralRevision", structural)
            put("entities", JsonArray(entries.entries.map { (k, e) -> image(k.substringBefore(':'), k.substringAfter(':'), e) }))
        }
    }

    override suspend fun delta(cursor: SyncCursor, watermark: SyncCursor?, limit: Int): JsonObject {
        gate()
        deltaRequests++
        if (resetNext) { resetNext = false; throw ApiException(409, "reset", "sync_reset_required", syncReset = true) }
        val mark = watermark?.sequence ?: seq
        val pending = log.filter { it.first > cursor.sequence && it.first <= mark }
        val page = pending.take(limit)
        val more = pending.size > page.size
        return buildJsonObject {
            put("contractVersion", 2); put("from", cursor(cursor.sequence))
            put("cursor", cursor(if (more) page.last().first else mark)); put("watermark", cursor(mark)); put("hasMore", more)
            put("changes", JsonArray(page.map { (s, img) -> buildJsonObject { put("sequence", s); put("entity", img) } }))
        }
    }

    override suspend fun entity(entity: String, id: String): JsonObject {
        gate()
        val e = entries["$entity:$id"]
        val seen = structural
        if (bumpStructuralAfterRead) { bumpStructuralAfterRead = false; structural += 1 }
        return buildJsonObject {
            put("contractVersion", 2); put("entity", entity); put("id", id); put("structuralRevision", seen)
            put("row", e?.row ?: JsonNull)
            put("version", e?.let { buildJsonObject { put("revision", it.revision); put("deletedAt", JsonNull) } } ?: JsonNull)
        }
    }

    override suspend fun applyChanges(envelope: JsonObject) {
        gate()
        val commandId = envelope["commandId"]!!.jsonPrimitive.content
        receipts[commandId]?.let { if (it == envelope) return else throw ApiException(409, "payload differs", "command_id_reused") }
        val cmd = envelope["commands"]!!.jsonArray.single().jsonObject
        val kind = cmd["kind"]!!.jsonPrimitive.content
        val id = cmd["id"]!!.jsonPrimitive.content
        if (cmd["expectedStructuralRevision"]?.jsonPrimitive?.longOrNull?.let { it != structural } == true) {
            throw ApiException(409, "graph moved", "structural_conflict")
        }
        val e = entries["task:$id"]
        val expected = cmd["expectedRevision"]?.jsonPrimitive?.longOrNull
        if (kind.startsWith("duty.")) {
            val d = entries["duty:$id"]
            if (kind == "duty.create") {
                if (d != null) throw ApiException(409, "exists", "revision_conflict", d.revision)
                val v = cmd["values"]!!.jsonObject
                val schedule = v["schedule"]!!.jsonObject
                record(id, JsonObject(dutyRow(id, v["title"]!!.jsonPrimitive.content, schedule["rrule"]!!.jsonPrimitive.content) + mapOf(
                    "dtstart" to schedule["dtstart"]!!, "timezone" to schedule["timezone"]!!, "catch_up" to v["catchUp"]!!,
                    "task_type" to v["taskType"]!!, "notes" to v["notes"]!!,
                )), "duty")
            } else {
                val row = d?.row ?: throw ApiException(404, "That duty doesn't exist.", "not_found")
                if (expected != d.revision) throw ApiException(409, "changed", "revision_conflict", d.revision)
                if (kind == "duty.content.set") {
                    val v = cmd["values"]!!.jsonObject
                    record(id, JsonObject(row + mapOf(
                        "title" to v["title"]!!, "notes" to v["notes"]!!, "kickoff_note" to v["kickoffNote"]!!,
                        "task_type" to v["taskType"]!!, "catch_up" to v["catchUp"]!!,
                    )), "duty")
                } else {
                    val status = cmd["status"]!!.jsonPrimitive.content
                    if (row["status"]!!.jsonPrimitive.content == "ended" || row["status"]!!.jsonPrimitive.content == status) {
                        throw ApiException(409, "invalid transition", "invalid_transition")
                    }
                    record(id, JsonObject(row + mapOf("status" to JsonPrimitive(status),
                        "next_occurrence_at" to if (status == "ended") JsonNull else row["next_occurrence_at"]!!)), "duty")
                }
            }
        } else if (kind == "task.create") {
            if (e != null) throw ApiException(409, "exists", "revision_conflict", e.revision)
            record(id, taskRow(id, cmd["values"]!!.jsonObject["title"]!!.jsonPrimitive.content))
        } else {
            val row = e?.row ?: throw ApiException(404, "That task doesn't exist.", "not_found")
            if (expected != e.revision) throw ApiException(409, "changed", "revision_conflict", e.revision)
            fun with(vararg kv: Pair<String, JsonElement>) = JsonObject(row + kv)
            when (kind) {
                "task.complete" -> {
                    record(id, with("status" to JsonPrimitive("done"), "focused_until" to JsonNull))
                    val successor = cmd["successor"]?.takeIf { it !is JsonNull }?.jsonObject?.get("id")?.jsonPrimitive?.content
                    if (successor != null) record(successor, taskRow(successor, recurrence = "FREQ=DAILY"))
                }
                "task.reopen" -> record(id, with("status" to JsonPrimitive("pending")))
                "task.focus.set" -> record(id, with("focused_until" to cmd["focusedUntil"]!!))
                "task.defer.set" -> record(id, with("defer_kind" to cmd["defer"]!!.jsonObject["kind"]!!, "focused_until" to JsonNull))
                "task.project.set" -> record(id, with("project_id" to cmd["project"]!!.let { if (it is JsonNull) it else it.jsonObject["id"]!! }))
                "task.legacy-schedule.set" -> record(id, with("due_date" to cmd["values"]!!.jsonObject["dueDate"]!!))
                "task.delete" -> record(id, null)
                else -> error("fake server does not know $kind")
            }
        }
        receipts[commandId] = envelope
        applied += envelope
        failAfterApply?.let { failAfterApply = null; throw it }
        if (loseNextResponse) { loseNextResponse = false; throw IOException("connection reset") }
    }
}
