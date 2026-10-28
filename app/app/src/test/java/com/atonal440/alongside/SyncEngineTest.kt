package com.atonal440.alongside

import com.atonal440.alongside.data.ApiException
import com.atonal440.alongside.data.sync.CanonicalWorkspace
import com.atonal440.alongside.data.sync.Intent
import com.atonal440.alongside.data.sync.MemorySyncStore
import com.atonal440.alongside.data.sync.QueuedOp
import com.atonal440.alongside.data.sync.RetainedReason
import com.atonal440.alongside.data.sync.SyncContractException
import com.atonal440.alongside.data.sync.SyncApi
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
    fun `a command committed behind a gateway error is not counted twice by the next write`() = runBlocking {
        server.put("t_aaaaa")
        val e = loaded()
        e.sync()
        e.commit(listOf(Intent.Focus("t_aaaaa", "2026-10-25T00:00:00Z")))
        server.failAfterApply = ApiException(502, "Bad gateway")
        val deltasBefore = server.deltaRequests
        e.sync()
        // The server committed it, but the phone doesn't know, so it must not pull the result in yet.
        assertEquals(2L, server.revision("t_aaaaa"))
        assertEquals(deltasBefore, server.deltaRequests)
        e.commit(listOf(Intent.Defer("t_aaaaa", "someday")))
        assertEquals(listOf(1L, 2L), store.state!!.queue.map { it.base })
        e.sync()
        assertTrue(e.retained.value.isEmpty())
        assertFalse(e.hasPendingWrites)
        assertEquals("someday", e.task("t_aaaaa")!!.defer_kind)
        assertEquals(3L, server.revision("t_aaaaa"))
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
    fun `retrying a completion of a task that started repeating names a successor`() = runBlocking {
        server.put("t_aaaaa")
        val e = loaded()
        e.sync()
        e.commit(listOf(Intent.Complete("t_aaaaa", null)))
        // Another device makes the task repeat first, so the completion is a revision conflict.
        server.edit("t_aaaaa") { JsonObject(it + ("recurrence" to JsonPrimitive("FREQ=DAILY"))) }
        e.sync()
        val retained = e.retained.value.single()
        assertTrue(retained.reason is RetainedReason.Conflict)
        e.retryRetained(listOf(retained.id))
        val retried = store.state!!.queue.single().intent as Intent.Complete
        assertTrue(retried.successorId != null)
        e.sync()
        assertTrue(e.retained.value.isEmpty())
        assertEquals(1L, server.revision(retried.successorId!!))
    }

    @Test
    fun `commands queued behind a conflicted one on the same task are held, not sent against a coincidental revision`() = runBlocking {
        server.put("t_aaaaa")
        val e = loaded()
        e.sync()
        e.commit(listOf(Intent.Focus("t_aaaaa", "2026-10-25T00:00:00Z"), Intent.Delete("t_aaaaa")))
        assertEquals(listOf(1L, 2L), store.state!!.queue.map { it.base })
        // Another device edits the task, so the focus conflicts and the delete's guess (2) now matches the server.
        server.edit("t_aaaaa") { JsonObject(it + ("title" to JsonPrimitive("Edited elsewhere"))) }
        e.sync()
        assertEquals(listOf("Conflict", "Dependency"), e.retained.value.map { it.reason::class.simpleName })
        assertEquals("Edited elsewhere", server.row("t_aaaaa")!!["title"]!!.jsonPrimitive.content)
        assertEquals("Edited elsewhere", e.task("t_aaaaa")!!.title)
        // Retrying both rebases them in order.
        e.retryRetained(e.retained.value.map { it.id })
        assertEquals(listOf(2L, 3L), store.state!!.queue.map { it.base })
    }

    @Test
    fun `retrying a complete-then-undo of a task that started repeating deletes the new successor`() = runBlocking {
        server.put("t_aaaaa")
        val e = loaded()
        e.sync()
        e.commit(listOf(Intent.Complete("t_aaaaa", null), Intent.Reopen("t_aaaaa")))
        server.edit("t_aaaaa") { JsonObject(it + ("recurrence" to JsonPrimitive("FREQ=DAILY"))) }
        e.sync()
        assertEquals(listOf("Conflict", "Dependency"), e.retained.value.map { it.reason::class.simpleName })
        e.retryRetained(e.retained.value.map { it.id })
        val queued = store.state!!.queue.map { it.intent }
        val successor = (queued[0] as Intent.Complete).successorId!!
        assertEquals(listOf(Intent.Complete("t_aaaaa", successor), Intent.Delete(successor), Intent.Reopen("t_aaaaa", successor)), queued)
        e.sync()
        assertTrue(e.retained.value.isEmpty())
        assertEquals("pending", e.task("t_aaaaa")!!.status)
        assertNull(e.task(successor))
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
        e.commit(listOf(Intent.Delete(successor), Intent.Reopen("t_aaaaa", successor)))
        e.sync()
        assertTrue(e.retained.value.isEmpty())
        assertEquals("pending", e.task("t_aaaaa")!!.status)
        assertNull(e.task(successor))
    }

    @Test
    fun `an undo whose successor delete is refused does not reopen the original`() = runBlocking {
        server.put("t_aaaaa", recurrence = "FREQ=DAILY")
        val e = loaded()
        e.sync()
        val successor = mintId("t")
        e.commit(listOf(Intent.Complete("t_aaaaa", successor)))
        e.sync()
        // Another device edits the successor before the undo reaches the server.
        server.edit(successor) { JsonObject(it + ("title" to JsonPrimitive("Edited"))) }
        e.commit(listOf(Intent.Delete(successor), Intent.Reopen("t_aaaaa", successor)))
        e.sync()
        val kinds = e.retained.value.map { it.reason::class.simpleName }
        assertEquals(listOf("Conflict", "Dependency"), kinds)
        assertEquals("done", server.row("t_aaaaa")!!["status"]!!.jsonPrimitive.content)
        assertEquals("Edited", e.task(successor)!!.title)
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
    fun `a queue made for one server is never sent to the server switched to`() = runBlocking {
        val old = FakeServer().also { it.put("t_aaaaa") }
        val next = FakeServer()
        var current: SyncApi = old
        val e = SyncEngine(MemorySyncStore(), { current }, { Instant.parse("2026-10-24T12:00:30Z") }, Dispatchers.Unconfined)
        e.load("https://old.example")
        e.sync()
        old.offline = true
        e.commit(listOf(Intent.Create("t_newnew", "Fig", null, "action")))
        e.reset("https://next.example") { current = next }
        e.sync()
        assertTrue(next.applied.isEmpty())
        assertTrue(old.applied.isEmpty())
        assertTrue(e.workspace.value.tasks.isEmpty())
    }

    @Test
    fun `after a crash between the canonical write and the state write absorbed commands are not counted twice`() = runBlocking {
        server.put("t_aaaaa")
        val e = loaded()
        e.sync()
        val before = store.state!!
        e.commit(listOf(Intent.Focus("t_aaaaa", "2026-10-25T00:00:00Z")))
        e.sync()
        // The pull saved the canonical file but the process died before the state that cleared `landed`.
        assertTrue(store.state!!.queue.isEmpty())
        val op = QueuedOp(99, "c_lost1", Intent.Focus("t_aaaaa", "2026-10-25T00:00:00Z"), 1, "2026-10-24T12:00:00Z")
        store.state = before.copy(landed = listOf(op), landedAt = before.landedAt ?: SyncCursor(0, 1))
        val restarted = loaded(engine())
        restarted.commit(listOf(Intent.Reopen("t_aaaaa")))
        assertEquals(server.revision("t_aaaaa"), store.state!!.queue.single().base)
        restarted.sync()
        assertTrue(restarted.retained.value.isEmpty())
    }

    @Test
    fun `landed commands are kept on restart unless the stored copy moved past them`() = runBlocking {
        val op = QueuedOp(7, "c_landed", Intent.Reopen("t_aaaaa"), 1, "2026-10-24T12:00:00Z")
        val keep = MemorySyncStore().also {
            it.state = com.atonal440.alongside.data.sync.SyncState("https://w.example", nextId = 8, landed = listOf(op), landedAt = SyncCursor(0, 5))
            it.canonical = com.atonal440.alongside.data.sync.CanonicalFile("https://w.example", SyncCursor(0, 3), emptyList())
        }
        loaded(engine(keep)).commit(listOf(Intent.Reopen("t_aaaaa")))
        assertEquals(1, keep.state!!.landed.size)
        val drop = MemorySyncStore().also {
            it.state = com.atonal440.alongside.data.sync.SyncState("https://w.example", nextId = 8, landed = listOf(op), landedAt = SyncCursor(0, 5))
            it.canonical = com.atonal440.alongside.data.sync.CanonicalFile("https://w.example", SyncCursor(0, 6), emptyList())
        }
        loaded(engine(drop)).commit(listOf(Intent.Reopen("t_aaaaa")))
        assertTrue(drop.state!!.landed.isEmpty())
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

    @Test
    fun `a due-date change keeps the server's repeat rule unless it sets one`() {
        val row = com.atonal440.alongside.data.AlongsideApi.json.decodeFromJsonElement(com.atonal440.alongside.data.Task.serializer(), server.taskRow("t_aaaaa", recurrence = "FREQ=DAILY"))
        val ctx = com.atonal440.alongside.data.sync.BuildContext(row, structuralRevision = 7, projectRevision = 3)
        fun values(intent: Intent) = com.atonal440.alongside.data.sync.buildEnvelope(QueuedOp(1, "c_abcde", intent, 2, "t"), ctx)["commands"]!!.jsonArray.single().jsonObject["values"]!!.jsonObject

        val kept = values(Intent.SetDue("t_aaaaa", "2026-11-01T12:00:00Z", dueAllDay = true))
        assertEquals("FREQ=DAILY", kept["recurrence"]!!.jsonPrimitive.content)

        val set = values(Intent.SetDue("t_aaaaa", "2026-11-01T09:00:00Z", dueAllDay = false, recurrence = "FREQ=WEEKLY;BYDAY=SU", setsRecurrence = true))
        assertEquals("FREQ=WEEKLY;BYDAY=SU", set["recurrence"]!!.jsonPrimitive.content)
        assertEquals("false", set["dueAllDay"]!!.jsonPrimitive.content)

        val task = com.atonal440.alongside.data.AlongsideApi.json.decodeFromJsonElement(com.atonal440.alongside.data.Task.serializer(), server.taskRow("t_aaaaa"))
        assertEquals("FREQ=WEEKLY", Intent.SetDue("t_aaaaa", "2026-11-01T12:00:00Z", true, "FREQ=WEEKLY", setsRecurrence = true).apply(task, "now").recurrence)
        assertEquals(task.recurrence, Intent.SetDue("t_aaaaa", "2026-11-01T12:00:00Z", true).apply(task, "now").recurrence)
    }
}
