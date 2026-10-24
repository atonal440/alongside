package com.atonal440.alongside

import com.atonal440.alongside.data.ApiException
import com.atonal440.alongside.data.sync.CanonicalWorkspace
import com.atonal440.alongside.data.sync.Intent
import com.atonal440.alongside.data.sync.MemorySyncStore
import com.atonal440.alongside.data.sync.QueuedOp
import com.atonal440.alongside.data.sync.RetainedReason
import com.atonal440.alongside.data.sync.SyncContractException
import com.atonal440.alongside.data.sync.SyncCursor
import com.atonal440.alongside.data.sync.SyncEngine
import com.atonal440.alongside.data.sync.SyncImage
import com.atonal440.alongside.data.sync.SyncStatus
import com.atonal440.alongside.data.sync.SyncWire
import com.atonal440.alongside.data.sync.applyStagedPull
import com.atonal440.alongside.data.sync.mintId
import com.atonal440.alongside.data.sync.predictBase
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.time.Instant

class SyncEngineTest {
    private val server = FakeServer()
    private val store = MemorySyncStore()
    private fun engine(s: MemorySyncStore = store) = SyncEngine(s, { server }, { Instant.parse("2026-10-24T12:00:30Z") }, Dispatchers.Unconfined)
    private fun loaded(e: SyncEngine = engine()) = runBlocking { e.load("https://w.example"); e }
    private fun SyncEngine.task(id: String) = workspace.value.task(id)

    @Test
    fun `first sync bootstraps from a snapshot and later syncs read deltas`() = runBlocking {
        server.put("t_aaaaa")
        val e = loaded()
        e.sync()
        assertEquals(listOf("t_aaaaa"), e.workspace.value.tasks.map { it.id })
        assertEquals(1, server.snapshotRequests)
        server.put("t_bbbbb")
        e.sync()
        assertEquals(setOf("t_aaaaa", "t_bbbbb"), e.workspace.value.tasks.map { it.id }.toSet())
        assertEquals(1, server.snapshotRequests)
        assertEquals(SyncStatus.Idle, e.status.value)
        assertTrue(store.canonical != null)
    }

    @Test
    fun `entities the app does not keep move the cursor without rewriting the stored copy`() = runBlocking {
        server.put("t_aaaaa")
        val e = loaded()
        e.sync()
        val stored = store.canonical
        server.noise()
        e.sync()
        assertTrue(stored === store.canonical)
        e.sync()
        assertEquals(1, e.workspace.value.tasks.size)
    }

    @Test
    fun `an offline write is shown at once, survives a failed sync and is sent once when back online`() = runBlocking {
        server.put("t_aaaaa")
        val e = loaded()
        e.sync()
        server.offline = true
        e.commit(listOf(Intent.Focus("t_aaaaa", "2026-10-25T00:00:00Z")))
        assertEquals("2026-10-25T00:00:00Z", e.task("t_aaaaa")!!.focused_until)
        e.sync()
        assertTrue(e.status.value is SyncStatus.Failed)
        assertEquals("2026-10-25T00:00:00Z", e.task("t_aaaaa")!!.focused_until)
        assertTrue(e.hasPendingWrites)
        server.offline = false
        e.sync()
        assertFalse(e.hasPendingWrites)
        assertEquals("2026-10-25T00:00:00Z", e.task("t_aaaaa")!!.focused_until)
        assertEquals(1, server.applied.size)
        assertEquals("2026-10-25T00:00:00Z", server.row("t_aaaaa")!!["focused_until"]!!.jsonPrimitive.content)
    }

    @Test
    fun `a lost response resends the saved envelope and the server applies it once`() = runBlocking {
        server.put("t_aaaaa")
        val e = loaded()
        e.sync()
        e.commit(listOf(Intent.Reopen("t_aaaaa")))
        server.loseNextResponse = true
        e.sync()
        assertTrue(e.hasPendingWrites)
        val savedId = store.state!!.queue.single().sent!!["commandId"]
        assertEquals(JsonPrimitive(store.state!!.queue.single().commandId), savedId)
        server.put("t_other")
        e.sync()
        assertFalse(e.hasPendingWrites)
        assertEquals(1, server.applied.size)
        assertEquals(2L, server.revision("t_aaaaa"))
    }

    @Test
    fun `a server error stops the flush and keeps everything queued in order`() = runBlocking {
        server.put("t_aaaaa"); server.put("t_bbbbb")
        val e = loaded()
        e.sync()
        e.commit(listOf(Intent.Focus("t_aaaaa", "2026-10-25T00:00:00Z"), Intent.Focus("t_bbbbb", "2026-10-25T00:00:00Z")))
        server.failNext = ApiException(503, "busy")
        e.sync()
        val queue = store.state!!.queue
        assertEquals(listOf("t_aaaaa", "t_bbbbb"), queue.map { it.intent.taskId })
        assertEquals(1, queue[0].attempts)
        assertTrue(store.state!!.retained.isEmpty())
        e.sync()
        assertFalse(e.hasPendingWrites)
        assertEquals(2, server.applied.size)
    }

    @Test
    fun `a write made against a stale revision is retained as a conflict and retrying rebases it`() = runBlocking {
        server.put("t_aaaaa")
        val e = loaded()
        e.sync()
        e.commit(listOf(Intent.Focus("t_aaaaa", "2026-10-25T00:00:00Z")))
        // Another device wrote the task before this phone's command got there.
        server.edit("t_aaaaa") { JsonObject(it + ("title" to JsonPrimitive("Renamed"))) }
        e.sync()
        val retained = e.retained.value.single()
        val reason = retained.reason as RetainedReason.Conflict
        assertEquals(2L, reason.currentRevision)
        assertEquals("Renamed", e.task("t_aaaaa")!!.title)
        assertNull(e.task("t_aaaaa")!!.focused_until)
        e.retryRetained(listOf(retained.id))
        assertTrue(e.retained.value.isEmpty())
        assertEquals(2L, store.state!!.queue.single().base)
        e.sync()
        assertEquals("2026-10-25T00:00:00Z", e.task("t_aaaaa")!!.focused_until)
        assertEquals("Renamed", e.task("t_aaaaa")!!.title)
    }

    @Test
    fun `a refused create retains the commands queued on its task`() = runBlocking {
        val e = loaded()
        e.sync()
        e.commit(listOf(Intent.Create("t_newnew", "Fig", null, "action"), Intent.SetProject("t_newnew", "p_x"), Intent.Create("t_fine1", "Ok", null, "action")))
        // The create is refused for good; the project move behind it can never apply.
        server.failNext = ApiException(422, "Title is not allowed.", "validation_failed")
        e.sync()
        val retained = e.retained.value
        assertEquals(2, retained.size)
        assertTrue(retained[0].reason is RetainedReason.Rejected)
        assertEquals(RetainedReason.Dependency("t_newnew", "Not sent because the task it depends on was rejected."), retained[1].reason)
        assertNull(e.task("t_newnew"))
        assertEquals("Ok", e.task("t_fine1")!!.title)
    }

    @Test
    fun `a structural conflict rebuilds the envelope once`() = runBlocking {
        server.put("t_aaaaa")
        val e = loaded()
        e.sync()
        e.commit(listOf(Intent.Complete("t_aaaaa", null)))
        server.bumpStructuralAfterRead = true
        e.sync()
        assertEquals("done", e.task("t_aaaaa")!!.status)
        assertTrue(e.retained.value.isEmpty())
        assertEquals(server.structural, server.applied.single()["commands"]!!.jsonArray.single().jsonObject["expectedStructuralRevision"]!!.jsonPrimitive.content.toLong())
    }

    @Test
    fun `completing a repeating task names its successor and undo can delete exactly that copy`() = runBlocking {
        server.put("t_aaaaa", recurrence = "FREQ=DAILY")
        val e = loaded()
        e.sync()
        val successor = mintId("t")
        e.commit(listOf(Intent.Complete("t_aaaaa", successor)))
        e.sync()
        assertEquals(1L, server.revision(successor))
        e.commit(listOf(Intent.Reopen("t_aaaaa"), Intent.Delete(successor)))
        e.sync()
        assertTrue(e.retained.value.isEmpty())
        assertEquals("pending", e.task("t_aaaaa")!!.status)
        assertNull(e.task(successor))
    }

    @Test
    fun `writes queued behind a landed command are guarded by the revision it left`() = runBlocking {
        server.put("t_aaaaa")
        val e = loaded()
        e.sync()
        e.commit(listOf(Intent.Complete("t_aaaaa", null), Intent.Reopen("t_aaaaa")))
        assertEquals(listOf(1L, 2L), store.state!!.queue.map { it.base })
        e.sync()
        assertTrue(e.retained.value.isEmpty())
        assertEquals("pending", e.task("t_aaaaa")!!.status)
        assertEquals(3L, server.revision("t_aaaaa"))
    }

    @Test
    fun `a sync reset from the server falls back to one snapshot`() = runBlocking {
        server.put("t_aaaaa")
        val e = loaded()
        e.sync()
        server.epoch = 2; server.seq = 40
        server.put("t_bbbbb")
        server.resetNext = true
        e.sync()
        assertEquals(2, server.snapshotRequests)
        assertEquals(setOf("t_aaaaa", "t_bbbbb"), e.workspace.value.tasks.map { it.id }.toSet())
    }

    @Test
    fun `the stored queue and canonical copy come back after a restart`() = runBlocking {
        server.put("t_aaaaa")
        val first = loaded()
        first.sync()
        server.offline = true
        first.commit(listOf(Intent.Focus("t_aaaaa", "2026-10-25T00:00:00Z")))
        val second = loaded(engine())
        assertEquals("2026-10-25T00:00:00Z", second.task("t_aaaaa")!!.focused_until)
        // A different server starts clean.
        val other = engine()
        runBlocking { other.load("https://other.example") }
        assertTrue(other.workspace.value.tasks.isEmpty())
    }

    @Test
    fun `switching source discards the queue`() = runBlocking {
        server.put("t_aaaaa")
        val e = loaded()
        e.sync()
        e.commit(listOf(Intent.Reopen("t_aaaaa")))
        e.reset("https://other.example")
        assertFalse(e.hasPendingWrites)
        assertTrue(e.workspace.value.tasks.isEmpty())
    }

    @Test
    fun `predicted bases count the commands ahead`() {
        val image = SyncImage("task", "t_aaaaa", 4, row = server.taskRow("t_aaaaa"))
        val canonical = CanonicalWorkspace(SyncCursor(1, 2), mapOf(image.id to image))
        fun op(i: Intent) = QueuedOp(1, "c_x", i, null, "2026-10-24T12:00:00Z")
        assertEquals(4L, predictBase(canonical, emptyList(), "task:t_aaaaa"))
        assertEquals(6L, predictBase(canonical, listOf(op(Intent.Reopen("t_aaaaa")), op(Intent.Complete("t_aaaaa", null))), "task:t_aaaaa"))
        assertEquals(1L, predictBase(canonical, listOf(op(Intent.Complete("t_aaaaa", "t_next1"))), "task:t_next1"))
        assertNull(predictBase(null, emptyList(), "task:t_new"))
    }

    @Test
    fun `a staged pull must continue exactly and may not regress a revision`() {
        val image = SyncImage("task", "t_aaaaa", 2, row = server.taskRow("t_aaaaa"))
        val base = CanonicalWorkspace(SyncCursor(1, 5), mapOf(image.id to image))
        fun page(from: Long, to: Long, revision: Long) = SyncWire.delta(kotlinx.serialization.json.buildJsonObject {
            val cur = { s: Long -> kotlinx.serialization.json.buildJsonObject { put("epoch", JsonPrimitive(1)); put("sequence", JsonPrimitive(s)) } }
            put("contractVersion", JsonPrimitive(2)); put("from", cur(from)); put("cursor", cur(to)); put("watermark", cur(to)); put("hasMore", JsonPrimitive(false))
            put("changes", kotlinx.serialization.json.JsonArray(listOf(kotlinx.serialization.json.buildJsonObject {
                put("sequence", JsonPrimitive(to))
                put("entity", kotlinx.serialization.json.buildJsonObject {
                    put("entity", JsonPrimitive("task")); put("key", JsonPrimitive("t_aaaaa")); put("revision", JsonPrimitive(revision))
                    put("deletedAt", JsonNull); put("row", server.taskRow("t_aaaaa"))
                })
            })))
        })
        assertEquals(SyncCursor(1, 6), applyStagedPull(base, listOf(page(5, 6, 3))).cursor)
        for (bad in listOf(page(4, 6, 3), page(5, 6, 2))) {
            try { applyStagedPull(base, listOf(bad)); fail("should have been rejected") } catch (_: SyncContractException) {}
        }
    }

    @Test
    fun `envelopes carry the guards the worker expects`() {
        val row = com.atonal440.alongside.data.AlongsideApi.json.decodeFromJsonElement(com.atonal440.alongside.data.Task.serializer(), server.taskRow("t_aaaaa", recurrence = "FREQ=DAILY"))
        val ctx = com.atonal440.alongside.data.sync.BuildContext(row, structuralRevision = 7, projectRevision = 3)
        fun env(intent: Intent, base: Long?) = com.atonal440.alongside.data.sync.buildEnvelope(QueuedOp(1, "c_abcde", intent, base, "t"), ctx)
        val complete = env(Intent.Complete("t_aaaaa", "t_next1"), 2)["commands"]!!.jsonArray.single().jsonObject
        assertEquals("task.complete", complete["kind"]!!.jsonPrimitive.content)
        assertEquals("2", complete["expectedRevision"]!!.jsonPrimitive.content)
        assertEquals("7", complete["expectedStructuralRevision"]!!.jsonPrimitive.content)
        assertEquals("t_next1", complete["successor"]!!.jsonObject["id"]!!.jsonPrimitive.content)
        val move = env(Intent.SetProject("t_aaaaa", "p_1"), 2)["commands"]!!.jsonArray.single().jsonObject
        assertEquals("3", move["project"]!!.jsonObject["expectedRevision"]!!.jsonPrimitive.content)
        try { env(Intent.Reopen("t_aaaaa"), null); fail("a command with no base is refused") } catch (_: com.atonal440.alongside.data.sync.EnvelopeRefused) {}
    }
}
