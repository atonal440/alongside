package com.atonal440.alongside

import com.atonal440.alongside.domain.DueSchedule
import com.atonal440.alongside.domain.DutySchedule
import com.atonal440.alongside.domain.dueSchedule
import com.atonal440.alongside.domain.dutySchedule
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

    @Test fun `a series with no time is all-day and has no zone`() {
        assertEquals(DutySchedule("FREQ=WEEKLY;BYDAY=SU", "2026-11-01T12:00:00Z", null), dutySchedule("FREQ=WEEKLY;BYDAY=SU", day, null, pacific))
    }

    @Test fun `a series with a time repeats at that clock time in the phone's zone`() {
        assertEquals(
            DutySchedule("FREQ=DAILY", "2026-11-01T17:00:00Z", "America/Los_Angeles"),
            dutySchedule("FREQ=DAILY", day, LocalTime.of(9, 0), pacific),
        )
    }

    @Test fun `a series whose first time falls in a spring-forward gap starts the next day instead of moving an hour`() {
        // 2:30 does not exist in Los Angeles on 14 Mar 2027; the next morning it is 2:30 PDT (UTC-7), 09:30 UTC.
        assertEquals(
            DutySchedule("FREQ=DAILY", "2027-03-15T09:30:00Z", "America/Los_Angeles"),
            dutySchedule("FREQ=DAILY", LocalDate.parse("2027-03-14"), LocalTime.of(2, 30), pacific),
        )
    }
}
