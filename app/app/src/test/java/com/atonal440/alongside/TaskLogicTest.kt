package com.atonal440.alongside

import com.atonal440.alongside.data.AlongsideApi
import com.atonal440.alongside.data.Task
import com.atonal440.alongside.data.TaskLink
import com.atonal440.alongside.data.Workspace
import com.atonal440.alongside.domain.Board
import com.atonal440.alongside.domain.Filters
import com.atonal440.alongside.domain.INBOX
import com.atonal440.alongside.domain.Show
import com.atonal440.alongside.domain.TemporalPoint
import com.atonal440.alongside.domain.deadlineBoundary
import com.atonal440.alongside.domain.parseInstant
import com.atonal440.alongside.domain.parseTemporalPoint
import com.atonal440.alongside.domain.recurrenceLabel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

class TaskLogicTest {
    private val now = Instant.now()
    private fun task(id: String, block: Task.() -> Task = { this }) =
        Task(id = id, title = id, created_at = "2026-01-01T00:00:00Z", updated_at = "2026-01-01T00:00:00Z").block()

    @Test
    fun `task rows parse with unknown fields and 0-1 booleans`() {
        val json = """[{"id":"t_1","title":"A","status":"pending","due_all_day":1,"defer_kind":"none","task_type":"plan","future_column":42,"created_at":"x","updated_at":"x"},
            {"id":"t_2","title":"B","due_all_day":null,"created_at":"x","updated_at":"x"},
            {"id":"t_3","title":"C","due_all_day":false,"created_at":"x","updated_at":"x"}]"""
        val rows = AlongsideApi.json.decodeFromString<List<Task>>(json)
        assertEquals(listOf(true, null, false), rows.map { it.due_all_day })
        val positions = AlongsideApi.json.decodeFromString<List<Task>>(
            """[{"id":"a","title":"A","position":2.5},{"id":"b","title":"B","position":"position"},{"id":"c","title":"C","position":null}]""",
        ).map { it.position }
        assertEquals(listOf(2.5, null, null), positions)
        assertTrue(rows[0].isPlan)
    }

    @Test
    fun `instants parse in every spelling the worker uses`() {
        assertEquals(Instant.parse("2026-10-24T18:00:00Z"), parseInstant("2026-10-24T18:00:00Z"))
        assertEquals(Instant.parse("2026-10-24T18:00:00Z"), parseInstant("2026-10-24 18:00:00"))
        assertEquals(Instant.parse("2026-10-24T12:00:00Z"), parseInstant("2026-10-24"))
        assertNull(parseInstant("not a date"))
    }

    @Test
    fun `a date deadline closes at the start of the next local day`() {
        val point = parseTemporalPoint("""{"kind":"date","date":"2026-10-15","timezone":"America/Los_Angeles"}""")
        assertEquals(TemporalPoint.OnDate(LocalDate.of(2026, 10, 15), ZoneId.of("America/Los_Angeles")), point)
        assertEquals(Instant.parse("2026-10-16T07:00:00Z"), point!!.deadlineBoundary())
        assertNull(parseTemporalPoint("""{"kind":"date"}"""))
    }

    @Test
    fun `tasks land in the right buckets`() {
        val future = now.plusSeconds(3600).toString()
        val ws = Workspace(
            tasks = listOf(
                task("ready"),
                task("focused") { copy(focused_until = future) },
                task("napping") { copy(defer_kind = "until", defer_until = future) },
                task("woke") { copy(defer_kind = "until", defer_until = now.minusSeconds(60).toString()) },
                task("someday") { copy(defer_kind = "someday") },
                task("blocked"),
                task("done") { copy(status = "done") },
                task("child") { copy(parent_id = "ready") },
            ),
            links = listOf(TaskLink("ready", "blocked", "blocks")),
        )
        val board = Board(ws, now)
        fun ids(show: Show) = board.filtered(Filters(show = setOf(show))).map { it.task.id }.toSet()
        assertEquals(setOf("ready", "focused", "woke"), ids(Show.Ready))
        assertEquals(setOf("focused"), ids(Show.Focus))
        assertEquals(setOf("napping"), ids(Show.Napping))
        assertEquals(setOf("someday"), ids(Show.Someday))
        assertEquals(setOf("blocked"), ids(Show.Waiting))
        assertEquals(setOf("done"), ids(Show.Done))
        assertEquals(1, board.facts("ready")!!.subtasks.size)
    }

    @Test
    fun `a finished blocker stops blocking`() {
        val ws = Workspace(
            tasks = listOf(task("first") { copy(status = "done") }, task("second")),
            links = listOf(TaskLink("first", "second", "blocks")),
        )
        assertFalse(Board(ws, now).facts("second")!!.isWaiting)
    }

    @Test
    fun `focused tasks sort first, then soonest`() {
        val ws = Workspace(
            tasks = listOf(
                task("later") { copy(due_date = now.plusSeconds(86_400 * 5).toString()) },
                task("undated"),
                task("soon") { copy(due_date = now.plusSeconds(86_400).toString()) },
                task("focus") { copy(focused_until = now.plusSeconds(3600).toString()) },
            ),
        )
        assertEquals(listOf("focus", "soon", "later", "undated"), Board(ws, now).filtered(Filters()).map { it.task.id })
    }

    @Test
    fun `project filter treats no project as the inbox`() {
        val ws = Workspace(tasks = listOf(task("a") { copy(project_id = "p_1") }, task("b")))
        val inbox = Board(ws, now).filtered(Filters(projects = setOf(INBOX))).map { it.task.id }
        assertEquals(listOf("b"), inbox)
    }

    @Test
    fun `recurrence rules read as plain words`() {
        assertEquals("Every 3 days", recurrenceLabel(task("x") { copy(recurrence = "FREQ=DAILY;INTERVAL=3") }))
        assertEquals("Weekly", recurrenceLabel(task("x") { copy(recurrence = "FREQ=WEEKLY;BYDAY=MO") }))
        assertEquals("Every 3 months", recurrenceLabel(task("x") { copy(recurrence = "RRULE:FREQ=MONTHLY;INTERVAL=3") }))
        assertEquals("Routine", recurrenceLabel(task("x") { copy(duty_id = "d_1") }))
        assertNull(recurrenceLabel(task("x")))
    }
}
