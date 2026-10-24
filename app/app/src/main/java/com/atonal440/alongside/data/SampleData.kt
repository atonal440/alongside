package com.atonal440.alongside.data

import com.atonal440.alongside.domain.Clock
import com.atonal440.alongside.domain.toWire
import java.time.LocalTime
import java.time.ZoneOffset

/** A small, believable workspace for looking around without a server. Dates are relative to today. */
object SampleData {
    fun workspace(): Workspace {
        val now = Clock.now()
        val today = Clock.today()
        val zone = Clock.zone
        fun day(offset: Long) = today.plusDays(offset).atTime(12, 0).atOffset(ZoneOffset.UTC).toInstant().toWire()
        fun at(offset: Long, hour: Int) = today.plusDays(offset).atTime(LocalTime.of(hour, 0)).atZone(zone).toInstant().toWire()
        fun deadline(offset: Long) = """{"kind":"date","date":"${today.plusDays(offset)}","timezone":"${zone.id}"}"""
        val created = now.minusSeconds(86_400 * 3).toWire()
        val stamp = now.toWire()

        fun task(
            id: String, title: String, project: String? = null, due: String? = null, allDay: Boolean? = null,
            deadline: String? = null, focused: Boolean = false, recurrence: String? = null, plan: Boolean = false,
            parent: String? = null, position: Double? = null, done: Boolean = false, deferKind: String = "none",
            deferUntil: String? = null, kickoff: String? = null, notes: String? = null,
        ) = Task(
            id = id, title = title, notes = notes, status = if (done) "done" else "pending",
            due_date = due, due_all_day = allDay ?: due?.let { true }, recurrence = recurrence, deadline = deadline,
            task_type = if (plan) "plan" else "action", project_id = project, kickoff_note = kickoff,
            defer_kind = deferKind, defer_until = deferUntil,
            focused_until = if (focused) Clock.endOfToday().toWire() else null,
            parent_id = parent, position = position, created_at = created, updated_at = stamp,
        )

        val projects = listOf(
            Project("p_taxes", "Taxes", created_at = created, updated_at = created),
            Project("p_reeds", "Reeds", created_at = created, updated_at = created),
            Project("p_home", "Home", created_at = created, updated_at = created),
            Project("p_alongside", "Alongside", created_at = created, updated_at = created),
        )

        val tasks = listOf(
            task(
                "t_tax", "Mail the Q3 estimated tax payment", "p_taxes", due = day(1), deadline = deadline(2),
                focused = true, recurrence = "FREQ=MONTHLY;INTERVAL=3",
                kickoff = "Vouchers are in the blue folder. Pay from savings, not checking, and copy the voucher number from last quarter's receipt.",
            ),
            task("t_tax_1", "Download the payment voucher", "p_taxes", parent = "t_tax", position = 1.0, done = true),
            task("t_tax_2", "Move money from savings", "p_taxes", parent = "t_tax", position = 2.0, done = true),
            task(
                "t_tax_3", "Pay online and save the receipt", "p_taxes", parent = "t_tax", position = 3.0,
                notes = "Pick \"Estimated tax\" and Q3. Screenshot the confirmation into Taxes/2026.",
            ),
            task("t_reeds", "Scrape and tie 12 reeds for Friday", "p_reeds", due = day(1), focused = true),
            task("t_marta", "Reply to Marta about the quartet date", due = at(0, 17), allDay = false),
            task("t_fig", "Water the fig, then the other fig", "p_home", due = day(2), recurrence = "FREQ=DAILY;INTERVAL=3"),
            task("t_duties", "Draft the duties screen for Alongside", "p_alongside", plan = true),
            task("t_duties_1", "List what a duty owns", "p_alongside", parent = "t_duties", position = 1.0),
            task("t_duties_2", "Sketch the routine list", "p_alongside", parent = "t_duties", position = 2.0),
            task("t_duties_3", "Decide on catch-up wording", "p_alongside", parent = "t_duties", position = 3.0),
            task("t_duties_4", "Prototype the editor", "p_alongside", parent = "t_duties", position = 4.0),
            task("t_key", "Get a spare practice-room key cut"),
            task("t_tuner", "Book the piano tuner", "p_home", deferKind = "until", deferUntil = at(2, 9)),
            task("t_library", "Return the library scores", deferKind = "until", deferUntil = at(2, 9)),
            task("t_schedule", "Send the quartet rehearsal schedule"),
            task("t_poulenc", "Learn the Poulenc trio", "p_reeds", deferKind = "someday"),
            task("t_repot", "Repot the snake plant", "p_home", deferKind = "someday"),
            task("t_shelves", "Put up the music shelves", "p_home", deferKind = "someday"),
            task("t_cane", "Pick up reed cane", "p_reeds", done = true),
            task("t_bill", "Pay the electric bill", "p_home", done = true),
        )
        val links = listOf(TaskLink("t_marta", "t_schedule", "blocks"))
        return Workspace(tasks, projects, links, syncedAtMillis = null)
    }
}
