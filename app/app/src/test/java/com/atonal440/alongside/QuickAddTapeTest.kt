package com.atonal440.alongside

import com.atonal440.alongside.data.ai.ModelFields
import com.atonal440.alongside.domain.QuickAddParser
import com.atonal440.alongside.domain.TapeDraft
import com.atonal440.alongside.domain.TapeLine
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.LocalTime

class QuickAddTapeTest {
    // A Wednesday.
    private val now = LocalDateTime.parse("2026-10-28T10:00:00")
    private fun parse(text: String) = QuickAddParser.parse(text, now)

    @Test fun `a sentence with a day prints what and when`() {
        val d = TapeDraft().printWhat(parse("call the dentist tomorrow at 3pm"))
        assertEquals(listOf(TapeLine.What, TapeLine.When), d.printed)
        assertEquals(LocalDate.parse("2026-10-29"), d.date)
        assertEquals(LocalTime.of(15, 0), d.time)
        assertTrue(d.title.contains("dentist"))
    }

    @Test fun `a sentence without a date prints only what, then asks when`() {
        val d = TapeDraft().printWhat(parse("buy stamps"))
        assertEquals(listOf(TapeLine.What), d.printed)
        assertEquals(TapeLine.When, d.pending(hasProjects = true))
    }

    @Test fun `questions run when, notes, project, skipping what is passed on or answered`() {
        var d = TapeDraft().printWhat(parse("buy stamps"))
        assertEquals(TapeLine.When, d.pending(true))
        d = d.skip(TapeLine.When)
        assertEquals(TapeLine.Notes, d.pending(true))
        d = d.printNotes("forever stamps")
        assertEquals(TapeLine.Project, d.pending(true))
        assertNull(d.pending(hasProjects = false))
        d = d.printProject("p1")
        assertNull(d.pending(true))
    }

    @Test fun `an answer to when that finds no date prints nothing`() {
        val d = TapeDraft().printWhat(parse("buy stamps"))
        assertEquals(d, d.printWhen(parse("whenever")))
        val answered = d.printWhen(parse("next friday"))
        assertEquals(LocalDate.parse("2026-11-06"), answered.date)
        assertTrue(TapeLine.When in answered.printed)
    }

    @Test fun `a repeat sets the time aside`() {
        val d = TapeDraft().printWhat(parse("water plants every sunday at 9am"))
        assertEquals("FREQ=WEEKLY;BYDAY=SU", d.recurrence)
        assertNull(d.time)
        assertEquals(LocalTime.of(9, 0), d.droppedTime)
    }

    @Test fun `choosing a time drops the repeat and choosing a repeat drops the time`() {
        val repeating = TapeDraft().printWhat(parse("water plants every sunday"))
        val timed = repeating.withTime(LocalTime.of(8, 30))
        assertNull(timed.recurrence)
        assertEquals(LocalTime.of(8, 30), timed.time)
        val back = timed.withRecurrence("FREQ=DAILY")
        assertNull(back.time)
        assertEquals("FREQ=DAILY", back.recurrence)
        // Clearing one leaves the other alone.
        assertEquals("FREQ=DAILY", back.withTime(null).recurrence)
    }

    @Test fun `the model fills title notes and kind but never overwrites an edit`() {
        val started = TapeDraft().printWhat(parse("figure out the taxes"))
        val fields = ModelFields("Sort out taxes", "gather receipts", plan = true)
        val filled = started.withModel(fields, started.title, started.notes, started.plan)
        assertEquals("Sort out taxes", filled.title)
        assertEquals("gather receipts", filled.notes)
        assertTrue(filled.plan)
        assertTrue(TapeLine.Notes in filled.printed)

        // Title and kind were changed while the model thought; notes were not.
        val edited = started.copy(title = "Taxes!", plan = true)
        val kept = edited.withModel(ModelFields("Sort out taxes", "gather receipts", plan = false), started.title, started.notes, started.plan)
        assertEquals("Taxes!", kept.title)
        assertTrue(kept.plan)
        assertEquals("gather receipts", kept.notes)
    }

    @Test fun `a model reply without notes prints no notes line`() {
        val started = TapeDraft().printWhat(parse("buy stamps"))
        val filled = started.withModel(ModelFields("Buy stamps", null, false), started.title, started.notes, started.plan)
        assertFalse(TapeLine.Notes in filled.printed)
    }

    @Test fun `removing a line resets it and stops it being asked again`() {
        val d = TapeDraft().printWhat(parse("pay rent on the 1st of every month")).remove(TapeLine.When)
        assertNull(d.date)
        assertNull(d.recurrence)
        assertFalse(TapeLine.When in d.printed)
        assertEquals(TapeLine.Notes, d.pending(true))
    }

    @Test fun `only a usable title can be torn off`() {
        assertFalse(TapeDraft().canTear)
        assertFalse(TapeDraft(title = "   ").canTear)
        assertTrue(TapeDraft(title = "x").canTear)
        assertFalse(TapeDraft(title = "x".repeat(201)).canTear)
        assertFalse(TapeDraft(title = "x", notes = "n".repeat(10_001)).canTear)
    }
}
