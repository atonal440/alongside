package com.atonal440.alongside

import com.atonal440.alongside.data.Settings
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SettingsTest {
    @Test
    fun `server addresses are normalized or rejected before saving`() {
        assertEquals("https://alongside.example.workers.dev", Settings.normalizeServerUrl(" alongside.example.workers.dev/ "))
        assertEquals("http://10.0.2.2:8787", Settings.normalizeServerUrl("http://10.0.2.2:8787"))
        assertNull(Settings.normalizeServerUrl(""))
        assertNull(Settings.normalizeServerUrl("not a url"))
        assertNull(Settings.normalizeServerUrl("ftp://example.com"))
    }
}
