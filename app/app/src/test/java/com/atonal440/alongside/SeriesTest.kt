package com.atonal440.alongside

import com.atonal440.alongside.data.Duty
import com.atonal440.alongside.domain.liveSeries
import org.junit.Assert.assertEquals
import org.junit.Test

class SeriesTest {
    private fun duty(id: String, status: String = "active", next: String? = "2026-11-01T12:00:00Z") =
        Duty(id = id, title = id, rrule = "FREQ=DAILY", dtstart = "2026-11-01T12:00:00Z", status = status, next_occurrence_at = next)

    @Test fun `the list hides ended series, puts soonest first and paused last`() {
        val list = liveSeries(
            listOf(
                duty("later", next = "2026-12-01T12:00:00Z"),
                duty("ended", status = "ended", next = null),
                duty("paused", status = "paused", next = "2026-10-30T12:00:00Z"),
                duty("soon", next = "2026-11-02T12:00:00Z"),
            ),
        )
        assertEquals(listOf("soon", "later", "paused"), list.map { it.id })
    }

    @Test fun `only a zoneless series anchored at noon UTC is all-day`() {
        assertEquals(true, duty("a").isAllDay)
        assertEquals(false, duty("b", next = "2026-11-01T17:00:00Z").isAllDay)
        assertEquals(false, duty("c").copy(timezone = "UTC").isAllDay)
    }
}
