package com.atonal440.alongside.domain

import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId

/** A due date in the spelling the worker stores: an instant, plus whether only the day matters. */
data class DueSchedule(val dueDate: String, val allDay: Boolean)

/**
 * Turns a picked day and an optional time into what the worker accepts. A date without a time is noon UTC and
 * all-day, like every other date-only due date the app writes; a time makes a local instant.
 */
fun dueSchedule(day: LocalDate, time: LocalTime?, zone: ZoneId): DueSchedule {
    if (time == null) return DueSchedule("${day}T12:00:00Z", allDay = true)
    return DueSchedule(day.atTime(time).atZone(zone).toInstant().toWire(), allDay = false)
}
