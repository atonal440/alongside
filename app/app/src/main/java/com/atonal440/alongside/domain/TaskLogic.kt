package com.atonal440.alongside.domain

import com.atonal440.alongside.data.Task
import com.atonal440.alongside.data.Workspace
import java.time.Instant
import java.time.LocalDate
import java.time.temporal.ChronoUnit

/** The views a task can show up in. A task can be in several (a focused task is also ready). */
enum class Show(val label: String, val chip: Boolean) {
    Ready("Ready", true),
    Focus("Focus", true),
    DueSoon("Due soon", true),
    Waiting("Waiting", true),
    Napping("Napping", false),
    Someday("Someday", true),
    Done("Done", false),
}

enum class When(val label: String) { Overdue("Overdue"), ThisWeek("This week"), HasDeadline("Has a deadline"), NoDate("No date") }
enum class Kind(val label: String) { Actions("Actions"), Plans("Plans"), Repeating("Repeating"), HasSubtasks("Has subtasks") }
enum class Order(val label: String) { Soonest("Soonest"), Newest("Newest"), AtoZ("A to Z") }

/** Project filter key for tasks with no project. */
const val INBOX = "inbox"

data class Filters(
    val show: Set<Show> = setOf(Show.Ready),
    val whens: Set<When> = emptySet(),
    val projects: Set<String> = emptySet(),
    val kinds: Set<Kind> = emptySet(),
    val order: Order = Order.Soonest,
    val query: String = "",
) {
    /** Badge count on the filter button: refinements beyond the chip row. */
    val refinementCount get() = whens.size + projects.size + kinds.size + (if (order != Order.Soonest) 1 else 0) +
        (if (show.size > 1 || show.any { !it.chip }) 1 else 0)

    val isPlainReady get() = show == setOf(Show.Ready) && whens.isEmpty() && projects.isEmpty() && kinds.isEmpty() && query.isBlank()

    fun cleared() = Filters(order = Order.Soonest)
}

/** Everything the list and widgets need to know about one task, worked out once per frame. */
class TaskFacts(val task: Task, ws: Workspace, now: Instant) {
    val subtasks = ws.children(task.id)
    val subtasksDone = subtasks.count { it.isDone }
    val target: Instant? = parseInstant(task.due_date)
    val targetAllDay = task.due_all_day ?: true
    /**
     * The task and its ancestors, nearest first; loop-safe and depth-bounded like
     * `chainOf` in shared/readiness.ts.
     */
    private val chain: List<Task> = buildList {
        add(task)
        val seen = mutableSetOf(task.id)
        var at = task.parent_id?.let(ws::task)
        while (at != null && at.id !in seen && size <= 33) {
            add(at)
            seen += at.id
            at = at.parent_id?.let(ws::task)
        }
    }

    /**
     * Hard date roles after inheritance, as `effectiveDates` in shared/readiness.ts: the earliest
     * deadline and the latest opening among the task and its ancestors. Ties go to the nearest.
     */
    val deadlinePoint: TemporalPoint? = chain.mapNotNull { parseTemporalPoint(it.deadline) }.minByOrNull { it.deadlineBoundary() }
    val deadline: Instant? = deadlinePoint?.deadlineBoundary()
    val opensAt: Instant? = chain.mapNotNull { parseTemporalPoint(it.available_from)?.openingBoundary() }.maxOrNull()
    val deferUntil: Instant? = parseInstant(task.defer_until)

    val isDone = task.isDone
    val isSomeday = !isDone && task.defer_kind == "someday"
    val isNapping = !isDone && task.defer_kind == "until" && deferUntil != null && deferUntil > now
    val isDeferred = isSomeday || isNapping
    val isFocused = !isDone && !isDeferred && parseInstant(task.focused_until)?.let { it > now } == true
    /** An unfinished prerequisite of the task or any ancestor blocks it, as in shared/readiness.ts. */
    val isBlocked = chain.any { member ->
        ws.links.any { link ->
            link.link_type == "blocks" && link.to_task_id == member.id && ws.task(link.from_task_id)?.isDone == false
        }
    }
    val notYetOpen = opensAt != null && opensAt > now
    val isWaiting = !isDone && !isDeferred && (isBlocked || notYetOpen)
    val isReady = !isDone && !isDeferred && !isWaiting
    val isRepeating = task.recurrence != null || task.duty_id != null

    /** The sooner of the hard deadline and the softer target; what "Soonest" sorts on. */
    val soonest: Instant? = listOfNotNull(target, deadline).minOrNull()

    val targetDay: LocalDate? = target?.atZone(Clock.zone)?.toLocalDate()
    val isOverdue = !isDone && (
        (deadline != null && deadline < now) ||
            (target != null && targetDay!! < Clock.today()) ||
            (target != null && !targetAllDay && target < now)
        )
    val isDueSoon = !isDone && !isDeferred && soonest != null &&
        ChronoUnit.DAYS.between(Clock.today(), soonest.atZone(Clock.zone).toLocalDate()) <= 3

    fun shows(show: Show) = when (show) {
        Show.Ready -> isReady
        Show.Focus -> isFocused
        Show.DueSoon -> isDueSoon
        Show.Waiting -> isWaiting
        Show.Napping -> isNapping
        Show.Someday -> isSomeday
        Show.Done -> isDone
    }

    fun matches(w: When, now: Instant) = when (w) {
        When.Overdue -> isOverdue
        When.ThisWeek -> soonest != null && soonest < now.plus(7, ChronoUnit.DAYS)
        When.HasDeadline -> deadline != null
        When.NoDate -> soonest == null
    }

    fun matches(k: Kind) = when (k) {
        Kind.Actions -> !task.isPlan
        Kind.Plans -> task.isPlan
        Kind.Repeating -> isRepeating
        Kind.HasSubtasks -> subtasks.isNotEmpty()
    }
}

/** A dated label on a task row. [urgent] ones get the peach tag; the rest are plain text. */
data class DateLabel(val text: String, val urgent: Boolean)

fun TaskFacts.dateLabel(short: Boolean = false): DateLabel? {
    val today = Clock.today()
    deadlinePoint?.let { point ->
        val day = point.displayDate()
        val days = ChronoUnit.DAYS.between(today, day)
        if (days <= 7 || target == null) {
            val dayText = when {
                days < 0 -> "passed ${friendlyDay(day)}"
                point is TemporalPoint.At && days == 0L -> "today ${friendlyTime(point.at, point.zone)}"
                days == 0L -> "today"
                else -> friendlyDay(day, withDayNumber = true)
            }
            return DateLabel(if (short) dayText.replaceFirstChar { it.uppercase() } else "Deadline $dayText", urgent = days <= 3)
        }
    }
    val target = target ?: return null
    val day = targetDay!!
    val days = ChronoUnit.DAYS.between(today, day)
    return when {
        days < 0 -> DateLabel(if (short) friendlyDay(day) else "Overdue · ${friendlyDay(day, withDayNumber = true)}", urgent = true)
        days == 0L -> DateLabel(
            if (targetAllDay) "Today" else if (short) friendlyTime(target) else "Today ${friendlyTime(target)}",
            urgent = true,
        )
        else -> DateLabel(if (short) friendlyDay(day) else "Aim for ${friendlyDay(day, withDayNumber = days > 6)}", urgent = false)
    }
}

/** "Every 3 days", "Weekly", "Every 2 months"; null for unreadable rules. Duty instances read "Routine". */
fun recurrenceLabel(task: Task): String? {
    val rule = task.recurrence ?: return if (task.duty_id != null) "Routine" else null
    val parts = rule.removePrefix("RRULE:").split(';').associate {
        val (k, v) = it.split('=', limit = 2).let { p -> p[0] to p.getOrElse(1) { "" } }
        k.uppercase() to v
    }
    val interval = parts["INTERVAL"]?.toIntOrNull() ?: 1
    val unit = when (parts["FREQ"]?.uppercase()) {
        "DAILY" -> "day"
        "WEEKLY" -> "week"
        "MONTHLY" -> "month"
        "YEARLY" -> "year"
        else -> return "Repeats"
    }
    return when {
        interval == 1 && unit == "day" -> "Every day"
        interval == 1 -> unit.replaceFirstChar { it.uppercase() } + "ly"
        else -> "Every $interval ${unit}s"
    }
}

private val PROJECT_COLORS = listOf(0xFF6FB8F0, 0xFFF59BBB, 0xFF8CCB4E, 0xFF9A86F0, 0xFFFFB45E, 0xFF4FC9B0)

/** Stable per-project dot color, hashed the same way as the PWA's projectColor. */
fun projectColor(projectId: String?): Long {
    if (projectId == null) return 0xFFB9B3DD
    var hash = 0L
    for (ch in projectId) hash = (hash * 31 + ch.code) and 0xFFFFFFFFL
    return PROJECT_COLORS[(hash % PROJECT_COLORS.size).toInt()]
}

data class Counts(
    val ready: Int, val focus: Int, val dueSoon: Int, val waiting: Int,
    val napping: Int, val someday: Int, val done: Int, val overdue: Int, val pending: Int,
) {
    fun of(show: Show) = when (show) {
        Show.Ready -> ready; Show.Focus -> focus; Show.DueSoon -> dueSoon; Show.Waiting -> waiting
        Show.Napping -> napping; Show.Someday -> someday; Show.Done -> done
    }
}

/** Precomputed facts for every top-level task; subtasks live inside their parent's detail. */
class Board(val ws: Workspace, val now: Instant = Clock.now()) {
    val facts: List<TaskFacts> = ws.tasks.filter { it.parent_id == null || ws.task(it.parent_id) == null }
        .map { TaskFacts(it, ws, now) }
    private val byId = facts.associateBy { it.task.id }

    fun facts(id: String): TaskFacts? = byId[id] ?: ws.task(id)?.let { TaskFacts(it, ws, now) }

    val counts = Counts(
        ready = facts.count { it.isReady },
        focus = facts.count { it.isFocused },
        dueSoon = facts.count { it.isDueSoon },
        waiting = facts.count { it.isWaiting },
        napping = facts.count { it.isNapping },
        someday = facts.count { it.isSomeday },
        done = facts.count { it.isDone },
        overdue = facts.count { it.isOverdue && !it.isDeferred },
        pending = facts.count { !it.isDone },
    )

    fun filtered(filters: Filters): List<TaskFacts> {
        val q = filters.query.trim()
        return facts.asSequence()
            .filter { f -> filters.show.any { f.shows(it) } }
            .filter { f -> filters.whens.isEmpty() || filters.whens.any { f.matches(it, now) } }
            .filter { f -> filters.projects.isEmpty() || (f.task.project_id ?: INBOX) in filters.projects }
            .filter { f -> filters.kinds.isEmpty() || filters.kinds.any { f.matches(it) } }
            .filter { f ->
                q.isEmpty() || f.task.title.contains(q, ignoreCase = true) || f.task.notes?.contains(q, ignoreCase = true) == true
            }
            .sortedWith(comparator(filters.order, filters.show == setOf(Show.Done)))
            .toList()
    }

    /** What "today" means for the progress widget: due or focused today, plus what got done today. */
    fun todayProgress(): Pair<Int, Int> {
        val today = Clock.today()
        fun dueToday(f: TaskFacts) = f.isOverdue || f.targetDay?.let { it <= today } == true ||
            f.deadlinePoint?.displayDate()?.let { it <= today } == true
        val left = facts.count { (it.isReady && (dueToday(it) || it.isFocused)) }
        val done = facts.count { it.isDone && parseInstant(it.task.updated_at)?.atZone(Clock.zone)?.toLocalDate() == today }
        return done to left
    }

    /** The headline task for the focus widget: a focused one, else the most pressing ready one. */
    fun headline(): TaskFacts? = facts.filter { it.isFocused }.minWithOrNull(comparator(Order.Soonest, false))
        ?: facts.filter { it.isReady }.minWithOrNull(comparator(Order.Soonest, false))

    companion object {
        fun comparator(order: Order, doneView: Boolean): Comparator<TaskFacts> = when {
            doneView -> compareByDescending { it.task.updated_at }
            order == Order.Newest -> compareByDescending { it.task.created_at }
            order == Order.AtoZ -> compareBy { it.task.title.lowercase() }
            else -> compareBy<TaskFacts> { !it.isFocused }
                .thenBy(nullsLast()) { it.soonest }
                .thenBy { it.task.created_at }
        }
    }
}

/** Header line under the greeting: "6 ready, 2 napping, nothing on fire." */
fun Counts.summary(): String {
    val parts = mutableListOf("$ready ready")
    if (napping > 0) parts += "$napping napping"
    if (waiting > 0) parts += "$waiting waiting"
    val fire = when (overdue) {
        0 -> "nothing on fire."
        1 -> "1 thing overdue."
        else -> "$overdue things overdue."
    }
    return parts.joinToString(", ") + ", " + fire
}
