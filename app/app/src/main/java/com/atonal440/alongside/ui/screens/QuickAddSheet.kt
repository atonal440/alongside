package com.atonal440.alongside.ui.screens

import android.text.format.DateFormat
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.MutableTransitionState
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.slideInVertically
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.gestures.detectVerticalDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TimePicker
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.material3.rememberTimePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.withFrameNanos
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Outline
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.onClick
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import com.atonal440.alongside.data.TaskLimits
import com.atonal440.alongside.data.Task
import com.atonal440.alongside.data.ai.ModelAvailability
import com.atonal440.alongside.data.ai.OnDeviceQuickAdd
import com.atonal440.alongside.domain.Board
import com.atonal440.alongside.domain.Clock
import com.atonal440.alongside.domain.INBOX
import com.atonal440.alongside.domain.QuickAddParser
import com.atonal440.alongside.domain.TapeDraft
import com.atonal440.alongside.domain.OptionalLines
import com.atonal440.alongside.domain.TapeLine
import com.atonal440.alongside.domain.friendlyDay
import com.atonal440.alongside.domain.recurrenceLabel
import com.atonal440.alongside.ui.components.AppIcons
import com.atonal440.alongside.ui.components.FilterChip
import com.atonal440.alongside.ui.components.IconBtn
import com.atonal440.alongside.ui.components.ProjectDot
import com.atonal440.alongside.ui.theme.LocalColors
import com.atonal440.alongside.ui.theme.Type
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.time.DayOfWeek
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.time.temporal.TemporalAdjusters
import java.util.Locale

/** What the last "say it" run did, kept for the debug card so a misread can be judged on a real device. */
private class QuickAddRun(
    val parserMillis: Double,
    val spans: List<String>,
    val modelMillis: Long? = null,
    val attempts: Int = 0,
    val raw: String = "",
    val note: String? = null,
)

private val timeLabel = DateTimeFormatter.ofPattern("h:mm a", Locale.getDefault())

private val repeatChoices = listOf("Never" to null, "Daily" to "FREQ=DAILY", "Weekly" to "FREQ=WEEKLY", "Monthly" to "FREQ=MONTHLY")

private fun quickDays(): List<Pair<String, LocalDate>> {
    val today = Clock.today()
    return listOf(
        "Today" to today,
        "Tomorrow" to today.plusDays(1),
        "Weekend" to today.with(TemporalAdjusters.nextOrSame(DayOfWeek.SATURDAY)),
        "Next week" to today.with(TemporalAdjusters.next(DayOfWeek.MONDAY)),
    )
}

private fun question(line: TapeLine) = when (line) {
    TapeLine.What -> "What needs doing? Say it your way."
    TapeLine.When -> "When? A day, a time or a repeat."
    TapeLine.Notes -> "Anything to remember about it?"
    TapeLine.Project -> "Which project does it belong to?"
    TapeLine.Kickoff -> "What will future-you need to get going?"
    TapeLine.NotBefore -> "Not before when? A day it opens."
    TapeLine.Waiting -> "What is it waiting on? Pick a task."
}

private fun example(line: TapeLine) = when (line) {
    TapeLine.What -> "water plants every sunday at 9am"
    TapeLine.When -> "friday at 5pm"
    TapeLine.Kickoff -> "where I left off, what to open first"
    TapeLine.NotBefore -> "next monday"
    TapeLine.Waiting -> "search your tasks"
    else -> "a note to future you"
}

/**
 * Quick capture as a sheet that grows one element at a time. Saying what the task is prints its title card, and
 * whatever the parser and the on-device model found (a day, a time, a repeat, notes) prints below it already
 * filled in, to be tapped and corrected. Each optional question after that prints its own element when
 * answered or goes away when passed on. The sheet can be torn off, and so added, at any point there is a title.
 * The element order and rules are in [TapeDraft]; this file is the screen for it.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun QuickAddSheet(
    board: Board,
    initialProject: String?,
    quickAdd: OnDeviceQuickAdd,
    onCreate: (TapeDraft) -> Unit,
    onDismiss: () -> Unit,
) {
    val c = LocalColors.current
    val scope = rememberCoroutineScope()
    val presetProject = initialProject?.takeIf { it != INBOX }
    val projects = remember(board) { board.ws.projects.filter { it.isActive } }
    var draft by remember { mutableStateOf(TapeDraft()) }
    var input by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var whenMissed by remember { mutableStateOf(false) }
    // An optional section the person asked to add; it takes the composer until answered or dropped.
    var asking by remember { mutableStateOf<TapeLine?>(null) }
    var availability by remember { mutableStateOf<Pair<ModelAvailability, String?>?>(null) }
    var downloadLine by remember { mutableStateOf<String?>(null) }
    var debug by remember { mutableStateOf(false) }
    var run by remember { mutableStateOf<QuickAddRun?>(null) }
    val tear = remember { Animatable(0f) }
    var tearing by remember { mutableStateOf(false) }
    val tapeScroll = rememberScrollState()

    LaunchedEffect(Unit) { availability = quickAdd.availability() }
    // A download started elsewhere (or before the sheet opened) finishes on its own; keep looking until it does.
    LaunchedEffect(availability?.first) {
        while (availability?.first == ModelAvailability.Downloading) {
            delay(3_000)
            availability = quickAdd.availability()
        }
    }
    LaunchedEffect(draft.printed.size) {
        // One frame for the new element to be measured, then bring it into view.
        withFrameNanos { }
        tapeScroll.animateScrollTo(tapeScroll.maxValue)
    }

    val active = asking ?: draft.pending(hasProjects = projects.isNotEmpty())

    // The parser answers at once; the model then fills in title, notes and kind from what is left of the sentence.
    fun sayWhat(text: String) {
        val t0 = System.nanoTime()
        val parsed = QuickAddParser.parse(text)
        val parserMillis = (System.nanoTime() - t0) / 1_000_000.0
        var next = TapeDraft().printWhat(parsed)
        if (presetProject != null) next = next.printProject(presetProject)
        draft = next
        input = ""
        val spans = parsed.spans.map { "${it.kind}: ${it.text}" }
        val ready = availability?.first == ModelAvailability.Available
        if (parsed.rest.isBlank() || !ready) {
            val note = if (parsed.rest.isBlank()) "Nothing left for the model." else "On-device model not ready; the parser filled what it could."
            run = QuickAddRun(parserMillis, spans, note = note)
            return
        }
        run = QuickAddRun(parserMillis, spans, note = "Asking the model…")
        busy = true
        val titleAtStart = next.title
        val notesAtStart = next.notes
        val planAtStart = next.plan
        scope.launch {
            val outcome = quickAdd.interpret(parsed.rest)
            outcome.fields?.let { draft = draft.withModel(it, titleAtStart, notesAtStart, planAtStart) }
            run = QuickAddRun(parserMillis, spans, outcome.millis, outcome.attempts, outcome.raw, outcome.error)
            busy = false
        }
    }

    fun submit() {
        val text = input.trim()
        if (text.isEmpty() || busy) return
        when (active) {
            TapeLine.What -> sayWhat(text)
            TapeLine.Kickoff -> { draft = draft.printKickoff(text); input = ""; asking = null }
            TapeLine.NotBefore -> {
                val next = draft.printNotBefore(QuickAddParser.parse(text))
                whenMissed = next == draft
                if (!whenMissed) { draft = next; input = ""; asking = null }
            }
            TapeLine.When -> {
                val next = draft.printWhen(QuickAddParser.parse(text))
                whenMissed = next == draft
                if (!whenMissed) { draft = next; input = "" }
            }
            TapeLine.Notes -> { draft = draft.printNotes(text); input = "" }
            else -> Unit
        }
    }

    // Only a valid capture tears off, so nothing typed is lost to a refusal later.
    fun tearOff() {
        if (!draft.canTear || tearing) return
        tearing = true
        scope.launch {
            tear.animateTo(1400f, tween(240))
            onCreate(draft)
            onDismiss()
        }
    }

    // Open tasks the new one could wait on, filtered by what has been typed while that section is open.
    val candidates = remember(board, input, active, draft.waitingOn) {
        if (active != TapeLine.Waiting) emptyList()
        else board.ws.tasks.filter { it.status == "pending" && it.id !in draft.waitingOn && it.title.contains(input.trim(), ignoreCase = true) }
            .sortedByDescending { it.updated_at }.take(12)
    }

    fun springBack() { scope.launch { tear.animateTo(0f, spring(stiffness = Spring.StiffnessMedium)) } }

    AlongsideSheet(onDismiss, sideMargin = 22.dp) {
        Column(Modifier.navigationBarsPadding().imePadding().padding(horizontal = 16.dp)) {
            QuickAddHeader(debug) { debug = !debug }
            Column(
                Modifier.weight(1f, fill = false).graphicsLayer {
                    translationY = tear.value
                    rotationZ = (tear.value / 70f).coerceAtMost(5f)
                    alpha = 1f - (tear.value / 900f).coerceIn(0f, 0.9f)
                }.clip(RoundedCornerShape(20.dp)).background(c.soft),
            ) {
                // Each section is a ticket: stacked edge to edge, with a half-circle bitten out of each side where
                // two meet, and the tear-off stub as the last one.
                Column(
                    Modifier.weight(1f, fill = false).fillMaxWidth().verticalScroll(tapeScroll).padding(start = 8.dp, end = 8.dp, top = 8.dp),
                ) {
                    if (draft.printed.isEmpty()) {
                        Text(
                            "Say it however it comes. What I find prints here, already filled in, and you can fix any of it.",
                            style = Type.body, color = c.muted, modifier = Modifier.padding(4.dp),
                        )
                    }
                    draft.printed.forEachIndexed { index, line ->
                        key(line) {
                            Printed(first = index == 0) {
                                when (line) {
                                    TapeLine.What -> WhatCard(draft, busy, onChange = { draft = it })
                                    TapeLine.When -> WhenCard(draft, onChange = { draft = it }, onRemove = { draft = draft.remove(TapeLine.When) })
                                    TapeLine.Notes -> NotesCard(draft, onChange = { draft = it }, onRemove = { draft = draft.remove(TapeLine.Notes) })
                                    TapeLine.Project -> ProjectCard(draft, board, onPick = { draft = draft.printProject(it) }, onRemove = { draft = draft.remove(TapeLine.Project) })
                                    TapeLine.Kickoff -> KickoffCard(draft, onChange = { draft = it }, onRemove = { draft = draft.remove(TapeLine.Kickoff) })
                                    TapeLine.NotBefore -> NotBeforeCard(draft, onChange = { draft = it }, onRemove = { draft = draft.remove(TapeLine.NotBefore) })
                                    TapeLine.Waiting -> WaitingCard(draft, board, onStop = { draft = draft.stopWaitingOn(it) }, onAddAnother = { if (input.isBlank()) asking = TapeLine.Waiting }, onRemove = { draft = draft.remove(TapeLine.Waiting) })
                                }
                            }
                        }
                    }
                    if (debug) run?.let { CompositionLocalProvider(LocalFirstTicket provides false) { DebugCard(it) } }
                }
                if (draft.canTear) TearLine(tear, onRelease = { if (tear.value > 90f) tearOff() else springBack() }, onCancel = ::springBack, onTearByAction = ::tearOff)
            }
            Composer(
                active = active, draft = draft, input = input, onInput = { input = it; whenMissed = false },
                onSubmit = ::submit,
                onSkip = { active?.let { if (asking != null) asking = null else draft = draft.skip(it); input = ""; whenMissed = false } },
                projects = board.ws.projects.filter { it.isActive }, onProject = { draft = draft.printProject(it) },
                candidates = candidates, onWaiting = { id -> draft = draft.printWaiting(id); asking = null; input = "" },
                onAsk = { line -> asking = line; input = ""; whenMissed = false },
                missed = whenMissed, busy = busy,
                availability = availability, downloadLine = downloadLine,
                onDownload = {
                    scope.launch {
                        runCatching { quickAdd.download().collect { downloadLine = it } }.onFailure { downloadLine = it.message }
                        availability = quickAdd.availability()
                    }
                },
            )
        }
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun QuickAddHeader(debug: Boolean, onToggleDebug: () -> Unit) {
    val c = LocalColors.current
    Text(
        "New task", style = Type.sheetTitle, color = c.ink,
        modifier = Modifier.padding(top = 4.dp, bottom = 8.dp)
            .combinedClickable(onClick = {}, onLongClick = onToggleDebug, onLongClickLabel = if (debug) "Hide timings and raw model reply" else "Show timings and raw model reply"),
    )
}

/** A new element slides up out of the text box when it is first printed. */
@Composable
private fun Printed(first: Boolean, content: @Composable () -> Unit) {
    val state = remember { MutableTransitionState(false).apply { targetState = true } }
    AnimatedVisibility(state, enter = fadeIn(tween(180)) + slideInVertically(tween(260)) { it / 3 } + expandVertically(tween(260))) {
        CompositionLocalProvider(LocalFirstTicket provides first) { content() }
    }
}

private val LocalFirstTicket = compositionLocalOf { true }

/**
 * A ticket: a rectangle whose corners are bitten out by quarter circles where it meets its neighbour, so two
 * stacked tickets show one half-circle notch on each side. An end of the stack ([notchTop] / [notchBottom] false)
 * has ordinary rounded corners instead.
 */
private class TicketShape(private val notch: Dp, private val notchTop: Boolean, private val notchBottom: Boolean, private val corner: Dp = 16.dp) : Shape {
    override fun createOutline(size: Size, layoutDirection: LayoutDirection, density: Density): Outline {
        val w = size.width
        val h = size.height
        val r = with(density) { notch.toPx() }
        val cr = with(density) { corner.toPx() }
        val path = Path().apply {
            if (notchTop) { moveTo(0f, r); arcTo(Rect(-r, -r, r, r), 90f, -90f, false) } else { moveTo(0f, cr); arcTo(Rect(0f, 0f, 2 * cr, 2 * cr), 180f, 90f, false) }
            if (notchTop) { lineTo(w - r, 0f); arcTo(Rect(w - r, -r, w + r, r), 180f, -90f, false) } else { lineTo(w - cr, 0f); arcTo(Rect(w - 2 * cr, 0f, w, 2 * cr), 270f, 90f, false) }
            if (notchBottom) { lineTo(w, h - r); arcTo(Rect(w - r, h - r, w + r, h + r), 270f, -90f, false) } else { lineTo(w, h - cr); arcTo(Rect(w - 2 * cr, h - 2 * cr, w, h), 0f, 90f, false) }
            if (notchBottom) { lineTo(r, h); arcTo(Rect(-r, h - r, r, h + r), 0f, -90f, false) } else { lineTo(cr, h); arcTo(Rect(0f, h - 2 * cr, 2 * cr, h), 90f, 90f, false) }
            close()
        }
        return Outline.Generic(path)
    }
}

/** The perforation along a ticket's top edge, between the two notches. */
private fun Modifier.perforatedTop(color: Color, notch: Dp): Modifier = drawBehind {
    val r = notch.toPx()
    drawLine(color, Offset(r + 4.dp.toPx(), 0f), Offset(size.width - r - 4.dp.toPx(), 0f), strokeWidth = 3f, pathEffect = PathEffect.dashPathEffect(floatArrayOf(14f, 12f)))
}

private val NotchRadius = 10.dp

@Composable
private fun TapeCard(label: String, onRemove: (() -> Unit)? = null, content: @Composable () -> Unit) {
    val c = LocalColors.current
    val first = LocalFirstTicket.current
    val shape = TicketShape(NotchRadius, notchTop = !first, notchBottom = true)
    Column(Modifier.fillMaxWidth().clip(shape).background(c.card).border(1.dp, c.line, shape).then(if (first) Modifier else Modifier.perforatedTop(c.line, NotchRadius)).padding(start = 14.dp, end = 4.dp, top = 2.dp, bottom = 10.dp)) {
        Row(Modifier.height(36.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(label.uppercase(), style = Type.section, color = c.muted, modifier = Modifier.weight(1f))
            if (onRemove != null) {
                Box(
                    Modifier.size(44.dp).clip(CircleShape).clickable(role = Role.Button, onClick = onRemove).semantics { contentDescription = "Remove $label" },
                    contentAlignment = Alignment.Center,
                ) { Icon(AppIcons.Close, null, Modifier.size(16.dp), tint = c.muted) }
            }
        }
        Column(Modifier.padding(end = 10.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) { content() }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun WhatCard(draft: TapeDraft, busy: Boolean, onChange: (TapeDraft) -> Unit) {
    val c = LocalColors.current
    TapeCard("What") {
        Field(draft.title, { onChange(draft.copy(title = it)) }, "What needs doing?", Type.rowTitle.copy(fontSize = Type.note.fontSize), singleLine = false, minLines = 1)
        if (draft.titleTooLong) LimitNote("Titles can be up to ${TaskLimits.TITLE_MAX} characters (this one is ${draft.title.trim().length}). Longer detail fits in the notes.")
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            FilterChip("Action", selected = !draft.plan, height = 36.dp, sheetStyle = true, showCheck = false, onClick = { onChange(draft.copy(plan = false)) })
            FilterChip("Plan", selected = draft.plan, height = 36.dp, sheetStyle = true, showCheck = false, onClick = { onChange(draft.copy(plan = true)) })
            if (busy) Text("Asking the on-device model…", style = Type.meta, color = c.muted)
        }
    }
}

@OptIn(ExperimentalLayoutApi::class, ExperimentalMaterial3Api::class)
@Composable
private fun WhenCard(draft: TapeDraft, onChange: (TapeDraft) -> Unit, onRemove: () -> Unit) {
    val c = LocalColors.current
    var datePicker by remember { mutableStateOf(false) }
    var timePicker by remember { mutableStateOf(false) }
    var repeatOpen by remember { mutableStateOf(false) }
    var daysOpen by remember { mutableStateOf(false) }
    val day = draft.date

    TapeCard("When", onRemove) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(day?.let { friendlyDay(it, withDayNumber = true) } ?: "Pick a day", selected = true, height = 36.dp, sheetStyle = true, showCheck = false, onClick = { daysOpen = !daysOpen })
            FilterChip(draft.time?.format(timeLabel) ?: "Add a time", selected = draft.time != null, height = 36.dp, sheetStyle = true, showCheck = false, onClick = { timePicker = true })
            FilterChip(
                draft.recurrence?.let { recurrenceLabel(it) ?: "Repeats" } ?: "Repeat", selected = draft.recurrence != null, height = 36.dp, sheetStyle = true, showCheck = false,
                leading = { Icon(AppIcons.Repeat, null, Modifier.size(18.dp), tint = c.ink) },
                onClick = { repeatOpen = !repeatOpen },
            )
        }
        if (repeatOpen) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                repeatChoices.forEach { (label, rule) ->
                    FilterChip(label, selected = draft.recurrence == rule, height = 36.dp, onClick = { onChange(draft.withRecurrence(rule)); repeatOpen = false })
                }
            }
        }
        // Tapping the day opens the shortcuts, with the full calendar as the last of them.
        if (daysOpen) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                quickDays().forEach { (label, date) -> FilterChip(label, selected = day == date, height = 32.dp, onClick = { onChange(draft.withDate(date)); daysOpen = false }) }
                FilterChip("Pick a date…", selected = false, height = 32.dp, onClick = { datePicker = true; daysOpen = false })
            }
        }
        draft.droppedTime?.let { Text("Repeats are date-only for now, so ${it.format(timeLabel)} was left out.", style = Type.meta, color = c.muted) }
        if (draft.approx) Text("Guessed from a vague phrase; check it.", style = Type.meta, color = c.muted)
    }

    if (datePicker) {
        val state = rememberDatePickerState(initialSelectedDateMillis = (day ?: Clock.today()).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli())
        DatePickerDialog(
            onDismissRequest = { datePicker = false },
            confirmButton = {
                TextButton(onClick = {
                    state.selectedDateMillis?.let { ms -> onChange(draft.withDate(Instant.ofEpochMilli(ms).atZone(ZoneOffset.UTC).toLocalDate())) }
                    datePicker = false
                }) { Text("Set day") }
            },
            dismissButton = { TextButton(onClick = { datePicker = false }) { Text("Cancel") } },
        ) { DatePicker(state) }
    }
    if (timePicker) {
        val start = draft.time ?: LocalTime.of(9, 0)
        val state = rememberTimePickerState(start.hour, start.minute, DateFormat.is24HourFormat(LocalContext.current))
        AlertDialog(
            onDismissRequest = { timePicker = false },
            text = { TimePicker(state) },
            confirmButton = { TextButton(onClick = { onChange(draft.withTime(LocalTime.of(state.hour, state.minute))); timePicker = false }) { Text("Set time") } },
            dismissButton = {
                Row {
                    if (draft.time != null) TextButton(onClick = { onChange(draft.withTime(null)); timePicker = false }) { Text("No time") }
                    TextButton(onClick = { timePicker = false }) { Text("Cancel") }
                }
            },
        )
    }
}

@Composable
private fun NotesCard(draft: TapeDraft, onChange: (TapeDraft) -> Unit, onRemove: () -> Unit) {
    TapeCard("Notes", onRemove) {
        Field(draft.notes, { onChange(draft.copy(notes = it)) }, "Notes", Type.body, singleLine = false)
        if (draft.notesTooLong) LimitNote("Notes can be up to ${TaskLimits.NOTES_MAX} characters (these are ${draft.notes.trim().length}).")
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ProjectCard(draft: TapeDraft, board: Board, onPick: (String?) -> Unit, onRemove: () -> Unit) {
    TapeCard("Project", onRemove) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip("Inbox", selected = draft.projectId == null, height = 36.dp, sheetStyle = true, onClick = { onPick(null) })
            board.ws.projects.filter { it.isActive }.forEach { p ->
                FilterChip(p.title, selected = draft.projectId == p.id, height = 36.dp, sheetStyle = true, leading = { ProjectDot(p.id, 9.dp) }, onClick = { onPick(p.id) })
            }
        }
    }
}

@Composable
private fun KickoffCard(draft: TapeDraft, onChange: (TapeDraft) -> Unit, onRemove: () -> Unit) {
    TapeCard("Kickoff note", onRemove) {
        Field(draft.kickoff, { onChange(draft.copy(kickoff = it)) }, "Kickoff note", Type.body, singleLine = false)
        if (draft.kickoffTooLong) LimitNote("Kickoff notes can be up to ${TaskLimits.KICKOFF_MAX} characters (this one is ${draft.kickoff.trim().length}).")
    }
}

@OptIn(ExperimentalLayoutApi::class, ExperimentalMaterial3Api::class)
@Composable
private fun NotBeforeCard(draft: TapeDraft, onChange: (TapeDraft) -> Unit, onRemove: () -> Unit) {
    var picker by remember { mutableStateOf(false) }
    val day = draft.availableFrom
    TapeCard("Not before", onRemove) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterChip(day?.let { friendlyDay(it, withDayNumber = true) } ?: "Pick a day", selected = true, height = 36.dp, sheetStyle = true, onClick = { picker = true })
            quickDays().forEach { (label, date) -> FilterChip(label, selected = day == date, height = 32.dp, onClick = { onChange(draft.withAvailableFrom(date)) }) }
        }
    }
    if (picker) {
        val state = rememberDatePickerState(initialSelectedDateMillis = (day ?: Clock.today()).atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli())
        DatePickerDialog(
            onDismissRequest = { picker = false },
            confirmButton = {
                TextButton(onClick = {
                    state.selectedDateMillis?.let { ms -> onChange(draft.withAvailableFrom(Instant.ofEpochMilli(ms).atZone(ZoneOffset.UTC).toLocalDate())) }
                    picker = false
                }) { Text("Set day") }
            },
            dismissButton = { TextButton(onClick = { picker = false }) { Text("Cancel") } },
        ) { DatePicker(state) }
    }
}

@Composable
private fun WaitingCard(draft: TapeDraft, board: Board, onStop: (String) -> Unit, onAddAnother: () -> Unit, onRemove: () -> Unit) {
    val c = LocalColors.current
    TapeCard("Waiting on", onRemove) {
        draft.waitingOn.forEach { id ->
            val title = board.ws.task(id)?.title ?: "A task that is no longer here"
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(title, style = Type.rowTitle, color = c.ink, modifier = Modifier.weight(1f), maxLines = 2)
                IconBtn(AppIcons.Close, "Stop waiting on $title", { onStop(id) }, size = 16.dp, tint = c.muted)
            }
        }
        FilterChip("Another task", selected = false, height = 36.dp, onClick = onAddAnother)
    }
}

@Composable
private fun DebugCard(run: QuickAddRun) {
    TapeCard("Under the hood") {
        Text(
            buildString {
                append("parser ${"%.1f".format(run.parserMillis)} ms")
                run.modelMillis?.let { append(" · model $it ms · ${run.attempts} ${if (run.attempts == 1) "try" else "tries"}") }
                if (run.spans.isNotEmpty()) append("\ncut: ${run.spans.joinToString("; ")}")
                run.note?.let { append("\n$it") }
                if (run.raw.isNotBlank()) append("\nraw: ${run.raw.trim().replace(Regex("\\s+"), " ")}")
            },
            style = Type.meta, color = LocalColors.current.muted,
        )
    }
}

/**
 * The perforation under the newest element. Dragging it down tears the sheet off and adds the task; the same
 * action is exposed to accessibility services, since a drag is not always possible.
 */
@Composable
private fun TearLine(tear: Animatable<Float, *>, onRelease: () -> Unit, onCancel: () -> Unit, onTearByAction: () -> Unit) {
    val c = LocalColors.current
    val scope = rememberCoroutineScope()
    val stub = TicketShape(NotchRadius, notchTop = true, notchBottom = false)
    Box(
        Modifier.padding(start = 8.dp, end = 8.dp, bottom = 8.dp).fillMaxWidth().height(48.dp)
            .clip(stub).background(c.lavender).perforatedTop(c.muted, NotchRadius)
            .pointerInput(Unit) {
                detectVerticalDragGestures(
                    onVerticalDrag = { change, dy -> change.consume(); scope.launch { tear.snapTo((tear.value + dy).coerceAtLeast(0f)) } },
                    onDragEnd = onRelease,
                    onDragCancel = onCancel,
                )
            }
            .semantics(mergeDescendants = true) { contentDescription = "Tear off and add the task"; onClick("Add the task") { onTearByAction(); true } },
        contentAlignment = Alignment.Center,
    ) {
        Row(
            Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Icon(AppIcons.ChevronRight, null, Modifier.size(16.dp).rotate(90f), tint = c.ink)
            Text("Pull to tear off and add", style = Type.label, color = c.ink)
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Composer(
    active: TapeLine?,
    draft: TapeDraft,
    input: String,
    onInput: (String) -> Unit,
    onSubmit: () -> Unit,
    onSkip: () -> Unit,
    projects: List<com.atonal440.alongside.data.Project>,
    onProject: (String?) -> Unit,
    candidates: List<Task>,
    onWaiting: (String) -> Unit,
    onAsk: (TapeLine) -> Unit,
    missed: Boolean,
    busy: Boolean,
    availability: Pair<ModelAvailability, String?>?,
    downloadLine: String?,
    onDownload: () -> Unit,
) {
    val c = LocalColors.current
    Column(Modifier.padding(top = 2.dp, bottom = 12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        // The model can still add notes, which would move the next question on under a half-typed answer.
        if (busy) {
            Text("Reading what you said…", style = Type.body, color = c.muted)
            return@Column
        }
        if (active == null) {
            Text(
                if (draft.canTear) "That's everything. Pull the sheet to add the task." else "Give it a title to add it.",
                style = Type.body, color = c.muted,
            )
        } else {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(question(active), style = Type.label, color = c.ink, modifier = Modifier.weight(1f))
                if (active != TapeLine.What) {
                    Text(
                        "Skip", style = Type.label, color = c.muted,
                        modifier = Modifier.heightIn(min = 40.dp).clip(RoundedCornerShape(8.dp)).clickable(role = Role.Button, onClick = onSkip).padding(horizontal = 12.dp, vertical = 12.dp),
                    )
                }
            }
        }
        if (active == TapeLine.Project) {
            FlowRow(
                Modifier.heightIn(max = 168.dp).verticalScroll(rememberScrollState()),
                horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                FilterChip("Inbox", selected = false, height = 40.dp, sheetStyle = true, onClick = { onProject(null) })
                projects.forEach { p -> FilterChip(p.title, selected = false, height = 40.dp, sheetStyle = true, leading = { ProjectDot(p.id, 9.dp) }, onClick = { onProject(p.id) }) }
            }
        } else if (active != null) {
            val focus = remember { FocusRequester() }
            LaunchedEffect(active) { focus.requestFocus() }
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.weight(1f)) {
                    Field(input, onInput, example(active), Type.body, Modifier.focusRequester(focus), imeAction = if (active == TapeLine.Waiting) ImeAction.Done else ImeAction.Send, onImeAction = onSubmit)
                }
                if (active != TapeLine.Waiting) {
                    Box(
                        Modifier.size(48.dp).clip(CircleShape).background(c.peach)
                            .clickable(enabled = input.isNotBlank(), role = Role.Button, onClick = onSubmit)
                            .semantics { contentDescription = "Print" },
                        contentAlignment = Alignment.Center,
                    ) { Icon(AppIcons.Back, null, Modifier.size(22.dp).rotate(90f), tint = c.onPeach) }
                }
            }
            if (active == TapeLine.Waiting) {
                if (candidates.isEmpty()) Text("No open tasks match.", style = Type.meta, color = c.muted)
                FlowRow(Modifier.heightIn(max = 168.dp).verticalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    candidates.forEach { t -> FilterChip(t.title, selected = false, height = 40.dp, sheetStyle = true, onClick = { onWaiting(t.id) }) }
                }
            }
            if (missed) Text("I couldn't find a day in that. Try \"friday\" or \"in 3 days\".", style = Type.meta, color = c.muted)
            if (active == TapeLine.What) {
                when (availability?.first) {
                    null -> Text("Checking the on-device model…", style = Type.meta, color = c.muted)
                    ModelAvailability.Available -> Text("Gemini Nano ready", style = Type.meta, color = c.muted)
                    ModelAvailability.Downloadable -> Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        FilterChip("Download model", selected = false, height = 40.dp, sheetStyle = true, onClick = onDownload)
                        downloadLine?.let { Text(it, style = Type.meta, color = c.muted) }
                    }
                    ModelAvailability.Downloading -> Text("Model is downloading…", style = Type.meta, color = c.muted)
                    ModelAvailability.Unavailable -> Text("No on-device model (${availability.second ?: "unsupported"}). Dates and repeats still work.", style = Type.meta, color = c.muted)
                }
            }
        }
        // Sections nobody asks for: offered once there is a task to add them to.
        val offered = OptionalLines.filter { it !in draft.printed && it != active }
        if (TapeLine.What in draft.printed && offered.isNotEmpty() && input.isBlank()) {
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                offered.forEach { line -> DashedChip("+ ${optionalLabel(line)}") { onAsk(line) } }
            }
        }
    }
}

private fun optionalLabel(line: TapeLine) = when (line) {
    TapeLine.Kickoff -> "Kickoff"
    TapeLine.NotBefore -> "Not before"
    else -> "Waiting on"
}

/** An empty section the sheet can print: dashed, so it reads as not there yet. */
@Composable
private fun DashedChip(text: String, onClick: () -> Unit) {
    val c = LocalColors.current
    Box(
        Modifier.height(36.dp).clip(RoundedCornerShape(12.dp)).clickable(role = Role.Button, onClick = onClick).drawBehind {
            drawRoundRect(c.muted, style = Stroke(width = 3f, pathEffect = PathEffect.dashPathEffect(floatArrayOf(12f, 10f))), cornerRadius = CornerRadius(12.dp.toPx()))
        }.padding(horizontal = 14.dp),
        contentAlignment = Alignment.Center,
    ) { Text(text, style = Type.label, color = c.ink, maxLines = 1) }
}
