package com.atonal440.alongside

import com.atonal440.alongside.domain.DueSchedule
import com.atonal440.alongside.domain.dueSchedule
import org.junit.Assert.assertEquals
import org.junit.Test
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId

class DueScheduleTest {
    private val day = LocalDate.parse("2026-11-01")
    private val pacific = ZoneId.of("America/Los_Angeles")

    @Test fun `a date alone is all-day at noon UTC`() {
        assertEquals(DueSchedule("2026-11-01T12:00:00Z", allDay = true), dueSchedule(day, null, pacific))
    }

    @Test fun `a time makes a local instant`() {
        // Daylight time ends in Los Angeles at 2:00 on 1 Nov 2026, so 9:00 that morning is PST (UTC-8): 17:00 UTC.
        assertEquals(DueSchedule("2026-11-01T17:00:00Z", allDay = false), dueSchedule(day, LocalTime.of(9, 0), pacific))
    }
}
