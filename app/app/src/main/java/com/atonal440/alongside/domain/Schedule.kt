package com.atonal440.alongside.domain

import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId

/** A due date in the spelling the worker stores: an instant, plus whether only the day matters. */
data class DueSchedule(val dueDate: String, val allDay: Boolean, val recurrence: String?)

/**
 * Turns a picked day, an optional time and an optional repeat into what the worker accepts. The legacy repeat
 * is date-only: a timed due date together with a repeat is refused (`recurrenceFromRow` in the worker), so a
 * repeat wins and the time is left out. A date without a time is noon UTC and all-day, like every other
 * date-only due date the app writes.
 */
fun dueSchedule(day: LocalDate, time: LocalTime?, recurrence: String?, zone: ZoneId): DueSchedule {
    if (time == null || recurrence != null) return DueSchedule("${day}T12:00:00Z", allDay = true, recurrence = recurrence)
    return DueSchedule(day.atTime(time).atZone(zone).toInstant().toWire(), allDay = false, recurrence = null)
}
