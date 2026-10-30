package com.atonal440.alongside.domain

import com.atonal440.alongside.data.Duty
import java.time.ZoneId
import java.time.ZoneOffset

/**
 * When a series next happens, as the Routines list and the series sheet say it: "Tomorrow", or "Thu 5 at 9 am" when it has a
 * clock time. An all-day series (no zone, anchored at noon UTC) names its UTC date. Null once it has ended or has
 * nothing left.
 */
fun nextOccurrenceLabel(duty: Duty, zone: ZoneId = Clock.zone): String? {
    if (duty.isEnded) return null
    val at = parseInstant(duty.next_occurrence_at) ?: return null
    if (duty.isAllDay) return friendlyDay(at.atOffset(ZoneOffset.UTC).toLocalDate(), withDayNumber = true)
    return "${friendlyDay(at.atZone(zone).toLocalDate(), withDayNumber = true)} at ${friendlyTime(at, zone)}"
}

/** The series the Routines tab lists: not ended, soonest first (paused ones last). */
fun liveSeries(duties: List<Duty>): List<Duty> =
    duties.filter { !it.isEnded }.sortedWith(compareBy<Duty> { it.isPaused }.thenBy { parseInstant(it.next_occurrence_at) ?: java.time.Instant.MAX })
