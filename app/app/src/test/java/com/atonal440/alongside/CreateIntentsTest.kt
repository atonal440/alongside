package com.atonal440.alongside

import com.atonal440.alongside.data.AlongsideApi
import com.atonal440.alongside.data.Task
import com.atonal440.alongside.data.sync.BuildContext
import com.atonal440.alongside.data.sync.CanonicalView
import com.atonal440.alongside.data.sync.EnvelopeRefused
import com.atonal440.alongside.data.sync.Intent
import com.atonal440.alongside.data.sync.QueuedOp
import com.atonal440.alongside.data.sync.SkipReason
import com.atonal440.alongside.data.sync.buildEnvelope
import com.atonal440.alongside.data.sync.overlay
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/** The extra things a quick-add can write at creation: kickoff note, opening day, and waiting-on links. */
class CreateIntentsTest {
    private val server = FakeServer()
    private fun row(deadline: String? = null): Task =
        AlongsideApi.json.decodeFromJsonElement(Task.serializer(), JsonObject(server.taskRow("t_aaaaa") + ("deadline" to (deadline?.let { kotlinx.serialization.json.JsonPrimitive(it) } ?: JsonNull))))
    private fun command(intent: Intent, base: Long?, row: Task? = row()): JsonObject =
        buildEnvelope(QueuedOp(1, "c_abcde", intent, base, "t"), BuildContext(row, structuralRevision = 7, projectRevision = null))["commands"]!!.jsonArray.single().jsonObject

    @Test fun `a create carries its kickoff note`() {
        val values = command(Intent.Create("t_aaaaa", "Taxes", null, "plan", kickoffNote = "Start with the W-2s"), null, null)["values"]!!.jsonObject
        assertEquals("Start with the W-2s", values["kickoffNote"]!!.jsonPrimitive.content)
        assertTrue(command(Intent.Create("t_aaaaa", "Taxes", null, "plan"), null, null)["values"]!!.jsonObject["kickoffNote"] is JsonNull)
    }

    @Test fun `an old queued create without a kickoff note still reads`() {
        val json = AlongsideApi.json
        val old = json.decodeFromString(Intent.serializer(), """{"type":"task.create","taskId":"t_aaaaa","title":"x","notes":null,"taskType":"action"}""")
        assertNull((old as Intent.Create).kickoffNote)
    }

    @Test fun `the opening day is sent with the deadline the server holds`() {
        val none = command(Intent.SetAvailableFrom("t_aaaaa", "2026-11-02", "America/Los_Angeles"), 1)
        assertEquals("task.dates.set", none["kind"]!!.jsonPrimitive.content)
        val values = none["values"]!!.jsonObject
        assertEquals("2026-11-02", values["availableFrom"]!!.jsonObject["date"]!!.jsonPrimitive.content)
        assertEquals("America/Los_Angeles", values["availableFrom"]!!.jsonObject["timezone"]!!.jsonPrimitive.content)
        assertTrue(values["deadline"] is JsonNull)

        val kept = command(Intent.SetAvailableFrom("t_aaaaa", "2026-11-02", "America/Los_Angeles"), 1, row("""{"kind":"date","date":"2026-12-01","timezone":"America/Los_Angeles"}"""))
        assertEquals("2026-12-01", kept["values"]!!.jsonObject["deadline"]!!.jsonObject["date"]!!.jsonPrimitive.content)

        val cleared = command(Intent.SetAvailableFrom("t_aaaaa", null, "UTC"), 1)
        assertTrue(cleared["values"]!!.jsonObject["availableFrom"] is JsonNull)
        try { command(Intent.SetAvailableFrom("t_aaaaa", "2026-11-02", "UTC"), 1, row("not json")); fail("an unreadable deadline is not overwritten") } catch (_: EnvelopeRefused) {}
    }

    @Test fun `waiting on is a blocks link from the blocker, guarded by the link's own revision`() {
        val add = command(Intent.Block("t_aaaaa", "t_bbbbb"), null)
        assertEquals("link.add", add["kind"]!!.jsonPrimitive.content)
        assertEquals("t_bbbbb", add["from"]!!.jsonPrimitive.content)
        assertEquals("t_aaaaa", add["to"]!!.jsonPrimitive.content)
        assertEquals("blocks", add["linkType"]!!.jsonPrimitive.content)
        assertTrue(add["expectedRevision"] is JsonNull)
        assertEquals("7", add["expectedStructuralRevision"]!!.jsonPrimitive.content)
        assertEquals("3", command(Intent.Block("t_aaaaa", "t_bbbbb"), 3)["expectedRevision"]!!.jsonPrimitive.content)
    }

    @Test fun `the view shows the kickoff note, opening day and the link at once`() {
        val ops = listOf(
            QueuedOp(1, "c_1", Intent.Create("t_new01", "Taxes", null, "plan", "Start with W-2s"), null, "2026-10-29T00:00:00Z"),
            QueuedOp(2, "c_2", Intent.SetAvailableFrom("t_new01", "2026-11-02", "UTC"), 1, "2026-10-29T00:00:00Z"),
            QueuedOp(3, "c_3", Intent.Block("t_new01", "t_aaaaa"), null, "2026-10-29T00:00:00Z"),
            QueuedOp(4, "c_4", Intent.Block("t_new01", "t_gone1"), null, "2026-10-29T00:00:00Z"),
        )
        val base = CanonicalView(listOf(row()), emptyList(), emptyList())
        val view = overlay(base, ops, null)
        val task = view.workspace.task("t_new01")!!
        assertEquals("Start with W-2s", task.kickoff_note)
        assertEquals("""{"kind":"date","date":"2026-11-02","timezone":"UTC"}""", task.available_from)
        assertEquals(listOf("t_aaaaa"), view.workspace.links.filter { it.to_task_id == "t_new01" }.map { it.from_task_id })
        assertEquals(listOf(null, null, null, SkipReason.TaskMissing), view.outcomes)
    }
}
