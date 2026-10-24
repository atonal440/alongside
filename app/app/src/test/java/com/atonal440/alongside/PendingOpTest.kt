package com.atonal440.alongside

import com.atonal440.alongside.data.AlongsideApi
import com.atonal440.alongside.data.ApiException
import com.atonal440.alongside.data.PendingOp
import com.atonal440.alongside.data.Settings
import com.atonal440.alongside.data.Task
import com.atonal440.alongside.data.Workspace
import com.atonal440.alongside.data.mintId
import kotlinx.serialization.json.JsonNull
import com.atonal440.alongside.data.isTransient
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.net.UnknownHostException

class PendingOpTest {
    @Test
    fun `the write queue round-trips through its disk format`() {
        val ops = listOf(
            PendingOp.Create("t_abcdef", "c_abcdef", "Buy reeds", null, "action", "p_1", "2026-10-25",
                sent = buildJsonObject { put("commandId", "c_abcdef") }),
            PendingOp.Patch("t_abcdef", buildJsonObject { put("defer_kind", "someday") }),
            PendingOp.Complete("t_abcde2", "c_abcde2", successorId = "t_next01", sent = buildJsonObject { put("commandId", "c_abcde2") }),
            PendingOp.Reopen("t_2", spawnedId = "t_3"),
            PendingOp.Delete("t_4"),
        )
        val serializer = ListSerializer(PendingOp.serializer())
        val text = AlongsideApi.json.encodeToString(serializer, ops)
        assertEquals(ops, AlongsideApi.json.decodeFromString(serializer, text))
    }

    @Test
    fun `network trouble and server errors are retried, refusals are not`() {
        assertTrue(UnknownHostException().isTransient())
        assertTrue(IOException("reset").isTransient())
        assertTrue(ApiException(503, "busy").isTransient())
        assertTrue(ApiException(429, "slow down").isTransient())
        assertFalse(ApiException(400, "bad").isTransient())
        assertFalse(ApiException(404, "gone").isTransient())
        assertFalse(ApiException(401, "token").isTransient())
    }

    @Test
    fun `server addresses are normalized or rejected before saving`() {
        assertEquals("https://alongside.example.workers.dev", Settings.normalizeServerUrl(" alongside.example.workers.dev/ "))
        assertEquals("http://10.0.2.2:8787", Settings.normalizeServerUrl("http://10.0.2.2:8787"))
        assertNull(Settings.normalizeServerUrl(""))
        assertNull(Settings.normalizeServerUrl("not a url"))
        assertNull(Settings.normalizeServerUrl("ftp://example.com"))
    }

    @Test
    fun `queued ops laid over a server reply keep later changes`() {
        val now = "2026-10-24T12:00:00Z"
        val server = Workspace(tasks = listOf(Task("t_abcdef", "Fig", focused_until = "2026-10-25T00:00:00Z")))
        // Focus landed on the server; the nap behind it is still queued.
        val nap = PendingOp.Patch("t_abcdef", buildJsonObject {
            put("defer_kind", "until"); put("defer_until", "2026-10-26T09:00:00Z"); put("focused_until", JsonNull)
        })
        val shown = nap.applyLocally(server, now).task("t_abcdef")!!
        assertEquals("until", shown.defer_kind)
        assertEquals("2026-10-26T09:00:00Z", shown.defer_until)
        assertNull(shown.focused_until)
    }

    @Test
    fun `an offline create shows up once and minted ids match the worker's shape`() {
        val create = PendingOp.Create(mintId("t"), mintId("c"), "Fig", null, "action", null, "2026-10-25")
        val ws = create.applyLocally(create.applyLocally(Workspace(), "2026-10-24T12:00:00Z"), "2026-10-24T12:00:00Z")
        assertEquals(1, ws.tasks.size)
        assertEquals("2026-10-25T12:00:00Z", ws.tasks[0].due_date)
        assertTrue(Regex("^t_[0-9A-Za-z_-]{5,64}$").matches(create.taskId))
        assertTrue(Regex("^c_[0-9A-Za-z_-]{5,64}$").matches(create.commandId))
    }
}
