package com.atonal440.alongside.domain

import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneId

/** A due date in the spelling the worker stores: an instant, plus whether only the day matters. */
data class DueSchedule(val dueDate: String, val allDay: Boolean)

/** A series' calendar in the spelling `duty.create` takes: the rule, the first occurrence as an instant, and the zone it repeats in. */
data class DutySchedule(val rrule: String, val dtstart: String, val timezone: String?)

/**
 * The calendar of a series that first happens on [day] ([time] when it has one). Without a time it is all-day: no zone, anchored
 * at noon UTC like every other date-only value the app writes. With one it repeats at that clock time in [zone].
 */
fun dutySchedule(rrule: String, day: LocalDate, time: LocalTime?, zone: ZoneId): DutySchedule {
    if (time == null) return DutySchedule(rrule, "${day}T12:00:00Z", null)
    // A wall-clock time that does not exist that day (spring forward) is skipped by the worker; anchoring it would
    // quietly move the whole series an hour, so the series starts the next day, where the time exists. (For a rule with an
    // interval or weekday filter that shifts its cadence by a day, in the one hour a year this can happen.)
    var start = day
    repeat(2) { if (zone.rules.getValidOffsets(start.atTime(time)).isEmpty()) start = start.plusDays(1) }
    return DutySchedule(rrule, start.atTime(time).atZone(zone).toInstant().toWire(), zone.id)
}

/**
 * Turns a picked day and an optional time into what the worker accepts. A date without a time is noon UTC and
 * all-day, like every other date-only due date the app writes; a time makes a local instant.
 */
fun dueSchedule(day: LocalDate, time: LocalTime?, zone: ZoneId): DueSchedule {
    if (time == null) return DueSchedule("${day}T12:00:00Z", allDay = true)
    return DueSchedule(day.atTime(time).atZone(zone).toInstant().toWire(), allDay = false)
}
