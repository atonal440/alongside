package com.atonal440.alongside.domain

import com.atonal440.alongside.data.TaskLimits
import com.atonal440.alongside.data.ai.ModelFields
import java.time.LocalDate
import java.time.LocalTime

/** One printed element of the quick-add sheet. Each is a small piece of ordinary UI the person can edit. */
enum class TapeLine {
    What, When, Notes, Project,

    /** Optional sections the person adds when they want them; they are never asked for. */
    Kickoff, NotBefore, Waiting,
}

/** The sections offered as "add" chips rather than asked for. */
val OptionalLines = listOf(TapeLine.Kickoff, TapeLine.NotBefore, TapeLine.Waiting)

/**
 * The task being built on the quick-add sheet. Lines are printed in the order they were answered; a line that
 * was never answered (or was dismissed) simply isn't there, and a title alone is a valid task. Everything is
 * immutable so the sheet can hold it in one piece of state and the rules stay testable off-device.
 */
data class TapeDraft(
    val title: String = "",
    val notes: String = "",
    val plan: Boolean = false,
    val date: LocalDate? = null,
    val time: LocalTime? = null,
    /** iCalendar RRULE body, as the parser writes it. Shown but not saved: new series belong to duties, which the app cannot create yet. */
    val recurrence: String? = null,
    /** The date, time or repeat was a guess from a vague phrase ("morning", "next week"): flag it for a check. */
    val approx: Boolean = false,
    val projectId: String? = null,
    /** What future-you needs when picking the task up; the most prominent field on the detail screen. */
    val kickoff: String = "",
    /** The day the task opens. */
    val availableFrom: LocalDate? = null,
    /** Ids of existing tasks this one waits on, in the order they were picked. */
    val waitingOn: List<String> = emptyList(),
    val printed: List<TapeLine> = emptyList(),
    /** Questions the person passed on, so they are not asked again. */
    val skipped: Set<TapeLine> = emptySet(),
) {
    val titleTooLong get() = title.trim().length > TaskLimits.TITLE_MAX
    val notesTooLong get() = notes.trim().length > TaskLimits.NOTES_MAX
    val kickoffTooLong get() = kickoff.trim().length > TaskLimits.KICKOFF_MAX
    val canTear get() = title.isNotBlank() && !titleTooLong && !notesTooLong && !kickoffTooLong

    /** The next question to ask, or null when everything has been answered or passed on. */
    fun pending(hasProjects: Boolean): TapeLine? = when {
        TapeLine.What !in printed -> TapeLine.What
        else -> listOf(TapeLine.When, TapeLine.Notes, TapeLine.Project).firstOrNull { line ->
            line !in printed && line !in skipped && (line != TapeLine.Project || hasProjects)
        }
    }

    /** The first answer: the parser's reading of the sentence, with the model's still to come. */
    fun printWhat(parsed: QuickAddParser.Parsed): TapeDraft {
        val what = copy(title = parsed.rest, notes = "", plan = false).withSchedule(parsed).print(TapeLine.What)
        return if (parsed.date != null) what.print(TapeLine.When) else what
    }

    /** An answer to "when?": prints the line only if a date was found, so a miss can be asked again. */
    fun printWhen(parsed: QuickAddParser.Parsed): TapeDraft =
        if (parsed.date == null) this else withSchedule(parsed).print(TapeLine.When)

    /**
     * The model's reading of the title, notes and kind. The fields stay editable while it thinks, so a field the
     * person changed since the request started ([titleAtStart] and friends) keeps their version.
     */
    fun withModel(fields: ModelFields, titleAtStart: String, notesAtStart: String, planAtStart: Boolean): TapeDraft {
        val next = copy(
            title = if (title == titleAtStart) fields.title else title,
            notes = if (notes == notesAtStart) fields.notes.orEmpty() else notes,
            plan = if (plan == planAtStart) fields.plan else plan,
        )
        return if (next.notes.isNotBlank()) next.print(TapeLine.Notes) else next
    }

    fun printNotes(text: String): TapeDraft = if (text.isBlank()) this else copy(notes = text.trim()).print(TapeLine.Notes)

    fun printKickoff(text: String): TapeDraft = if (text.isBlank()) this else copy(kickoff = text.trim()).print(TapeLine.Kickoff)

    /** An answer to "not before?": prints the line only if a day was found, like [printWhen]. */
    fun printNotBefore(parsed: QuickAddParser.Parsed): TapeDraft =
        if (parsed.date == null) this else copy(availableFrom = parsed.date).print(TapeLine.NotBefore)

    fun withAvailableFrom(day: LocalDate): TapeDraft = copy(availableFrom = day)

    /** Adds [id] to what the task waits on (a task already listed is left where it was). */
    fun printWaiting(id: String): TapeDraft = copy(waitingOn = if (id in waitingOn) waitingOn else waitingOn + id).print(TapeLine.Waiting)

    fun stopWaitingOn(id: String): TapeDraft {
        val rest = waitingOn - id
        return if (rest.isEmpty()) remove(TapeLine.Waiting) else copy(waitingOn = rest)
    }

    fun printProject(id: String?): TapeDraft = copy(projectId = id).print(TapeLine.Project)

    fun skip(line: TapeLine): TapeDraft = copy(skipped = skipped + line)

    /** Takes a printed line back off the sheet and resets what it held; it is not asked about again. */
    fun remove(line: TapeLine): TapeDraft {
        val cleared = when (line) {
            TapeLine.What -> this
            TapeLine.When -> copy(date = null, time = null, recurrence = null, approx = false)
            TapeLine.Notes -> copy(notes = "")
            TapeLine.Project -> copy(projectId = null)
            TapeLine.Kickoff -> copy(kickoff = "")
            TapeLine.NotBefore -> copy(availableFrom = null)
            TapeLine.Waiting -> copy(waitingOn = emptyList())
        }
        return cleared.copy(printed = printed - line, skipped = skipped + line)
    }

    fun withDate(day: LocalDate): TapeDraft = copy(date = day, approx = false)

    fun withTime(at: LocalTime?): TapeDraft = copy(time = at, approx = false)

    private fun withSchedule(parsed: QuickAddParser.Parsed): TapeDraft = copy(
        date = parsed.date,
        time = parsed.time,
        recurrence = parsed.recurrence,
        approx = parsed.approx,
    )

    private fun print(line: TapeLine): TapeDraft = copy(printed = if (line in printed) printed else printed + line, skipped = skipped - line)
}
