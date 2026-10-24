package com.atonal440.alongside.domain

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.time.format.TextStyle
import java.time.temporal.ChronoUnit
import java.time.temporal.TemporalAdjusters
import java.util.Locale

/** Parses the worker's timestamps: ISO instants, SQLite `YYYY-MM-DD HH:MM:SS`, or bare dates (noon UTC). */
fun parseInstant(text: String?): Instant? {
    if (text.isNullOrBlank()) return null
    runCatching { return Instant.parse(text) }
    runCatching { return LocalDateTime.parse(text.replace(' ', 'T')).toInstant(ZoneOffset.UTC) }
    runCatching { return LocalDate.parse(text).atTime(12, 0).toInstant(ZoneOffset.UTC) }
    return null
}

/** Minute-resolution ISO instant, the spelling the worker stores. */
fun Instant.toWire(): String = truncatedTo(ChronoUnit.MINUTES).toString()

/**
 * A date-role column (`deadline`, `available_from`) holds TemporalPoint JSON text. A date point
 * keeps its own zone: a date deadline allows completion until the start of the next local day,
 * a date opening starts at the beginning of its day (docs/shared/schema.md "Date roles").
 */
sealed interface TemporalPoint {
    data class OnDate(val date: LocalDate, val zone: ZoneId) : TemporalPoint
    data class At(val at: Instant, val zone: ZoneId) : TemporalPoint
}

private val pointJson = Json { ignoreUnknownKeys = true }

fun parseTemporalPoint(text: String?): TemporalPoint? {
    if (text.isNullOrBlank()) return null
    return runCatching {
        val obj = pointJson.parseToJsonElement(text).jsonObject
        val zone = ZoneId.of(obj["timezone"]!!.jsonPrimitive.content)
        when (obj["kind"]!!.jsonPrimitive.content) {
            "date" -> TemporalPoint.OnDate(LocalDate.parse(obj["date"]!!.jsonPrimitive.content), zone)
            "instant" -> TemporalPoint.At(Instant.parse(obj["at"]!!.jsonPrimitive.content), zone)
            else -> null
        }
    }.getOrNull()
}

fun TemporalPoint.deadlineBoundary(): Instant = when (this) {
    is TemporalPoint.OnDate -> date.plusDays(1).atStartOfDay(zone).toInstant()
    is TemporalPoint.At -> at
}

fun TemporalPoint.openingBoundary(): Instant = when (this) {
    is TemporalPoint.OnDate -> date.atStartOfDay(zone).toInstant()
    is TemporalPoint.At -> at
}

/** The calendar day a deadline belongs to, in the zone it was entered in. */
fun TemporalPoint.displayDate(): LocalDate = when (this) {
    is TemporalPoint.OnDate -> date
    is TemporalPoint.At -> at.atZone(zone).toLocalDate()
}

object Clock {
    val zone: ZoneId get() = ZoneId.systemDefault()
    fun now(): Instant = Instant.now()
    fun today(): LocalDate = LocalDate.now(zone)
    fun endOfToday(): Instant = today().plusDays(1).atStartOfDay(zone).toInstant()
}

private val dayMonth = DateTimeFormatter.ofPattern("d MMM", Locale.getDefault())
private val clockTime = DateTimeFormatter.ofPattern("h:mm a", Locale.getDefault())

fun weekdayShort(date: LocalDate): String = date.dayOfWeek.getDisplayName(TextStyle.SHORT, Locale.getDefault())
fun weekdayLong(date: LocalDate): String = date.dayOfWeek.getDisplayName(TextStyle.FULL, Locale.getDefault())

/** "Today", "Tomorrow", "Thu", "Thu 15" or "21 Oct", from the viewer's today. */
fun friendlyDay(date: LocalDate, withDayNumber: Boolean = false): String {
    val today = Clock.today()
    val days = ChronoUnit.DAYS.between(today, date)
    return when {
        days == 0L -> "Today"
        days == 1L -> "Tomorrow"
        days == -1L -> "Yesterday"
        days in 2..6 -> if (withDayNumber) "${weekdayShort(date)} ${date.dayOfMonth}" else weekdayShort(date)
        else -> date.format(dayMonth)
    }
}

/** "5 pm" or "5:30 pm". */
fun friendlyTime(at: Instant): String {
    val local = at.atZone(Clock.zone).toLocalTime()
    val text = if (local.minute == 0) {
        DateTimeFormatter.ofPattern("h a", Locale.getDefault()).format(local)
    } else {
        clockTime.format(local)
    }
    return text.lowercase(Locale.getDefault()).replace(".", "")
}

fun longDate(date: LocalDate): String =
    "${weekdayLong(date)}, ${date.dayOfMonth} ${date.month.getDisplayName(TextStyle.FULL, Locale.getDefault())}"

fun greeting(name: String, now: ZonedDateTime = ZonedDateTime.now(Clock.zone)): String {
    val part = when (now.hour) {
        in 4..11 -> "Morning"
        in 12..16 -> "Afternoon"
        else -> "Evening"
    }
    return if (name.isBlank()) "Good ${part.lowercase()}" else "$part, $name"
}

/** Quick snooze targets offered by "Nap until…". */
enum class NapChoice(val label: String) {
    Tonight("This evening"),
    Tomorrow("Tomorrow morning"),
    Weekend("This weekend"),
    NextWeek("Next week"),
    Someday("Someday");

    fun until(): Instant? {
        val zone = Clock.zone
        val today = Clock.today()
        val morning = LocalTime.of(9, 0)
        return when (this) {
            Tonight -> today.atTime(18, 0).atZone(zone).toInstant()
            Tomorrow -> today.plusDays(1).atTime(morning).atZone(zone).toInstant()
            Weekend -> today.with(TemporalAdjusters.next(DayOfWeek.SATURDAY)).atTime(morning).atZone(zone).toInstant()
            NextWeek -> today.with(TemporalAdjusters.next(DayOfWeek.MONDAY)).atTime(morning).atZone(zone).toInstant()
            Someday -> null
        }
    }

    fun hint(): String = until()?.let { at ->
        val date = at.atZone(Clock.zone).toLocalDate()
        "${friendlyDay(date, withDayNumber = true)}, ${friendlyTime(at)}"
    } ?: "No date, out of the way"

    companion object {
        fun available(): List<NapChoice> {
            val hour = ZonedDateTime.now(Clock.zone).hour
            return entries.filter { it != Tonight || hour < 17 }
        }
    }
}
