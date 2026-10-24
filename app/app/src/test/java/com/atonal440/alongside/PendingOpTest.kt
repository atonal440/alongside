package com.atonal440.alongside

import com.atonal440.alongside.data.AlongsideApi
import com.atonal440.alongside.data.ApiException
import com.atonal440.alongside.data.PendingOp
import com.atonal440.alongside.data.Settings
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
            PendingOp.Create("local_1", buildJsonObject { put("title", "Buy reeds") }),
            PendingOp.Patch("local_1", buildJsonObject { put("defer_kind", "someday") }),
            PendingOp.Complete("t_2"),
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
}
