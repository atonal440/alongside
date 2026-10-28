package com.atonal440.alongside.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import com.atonal440.alongside.data.TaskLimits
import com.atonal440.alongside.data.ai.ModelAvailability
import com.atonal440.alongside.data.ai.OnDeviceQuickAdd
import com.atonal440.alongside.domain.Board
import com.atonal440.alongside.domain.Clock
import com.atonal440.alongside.domain.Filters
import com.atonal440.alongside.domain.INBOX
import com.atonal440.alongside.domain.Kind
import com.atonal440.alongside.domain.NapChoice
import com.atonal440.alongside.domain.QuickAddParser
import com.atonal440.alongside.domain.friendlyDay
import com.atonal440.alongside.domain.recurrenceLabel
import com.atonal440.alongside.domain.Order
import com.atonal440.alongside.domain.Show
import com.atonal440.alongside.domain.When
import com.atonal440.alongside.ui.components.AppIcons
import com.atonal440.alongside.ui.components.FilterChip
import com.atonal440.alongside.ui.components.PrimaryButton
import com.atonal440.alongside.ui.components.ProjectDot
import com.atonal440.alongside.ui.theme.LocalColors
import com.atonal440.alongside.ui.theme.Type
import java.time.DayOfWeek
import java.time.LocalDate
import java.time.LocalTime
import java.time.format.DateTimeFormatter
import java.util.Locale
import java.time.temporal.TemporalAdjusters

private fun <T> Set<T>.toggle(item: T) = if (item in this) this - item else this + item

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AlongsideSheet(onDismiss: () -> Unit, content: @Composable () -> Unit) {
    val c = LocalColors.current
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = c.surface,
        scrimColor = c.scrim,
        shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp),
        dragHandle = { Box(Modifier.padding(top = 10.dp).size(36.dp, 4.dp).clip(RoundedCornerShape(2.dp)).background(c.line)) },
    ) { content() }
}

@Composable
private fun SheetLabel(text: String) {
    Text(text.uppercase(), style = Type.section, color = LocalColors.current.muted, modifier = Modifier.padding(bottom = 10.dp))
}

/** "Narrow it down": the full filter set, applied when the person taps "Show N tasks". */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun FiltersSheet(board: Board, current: Filters, onApply: (Filters) -> Unit, onDismiss: () -> Unit) {
    val c = LocalColors.current
    var draft by remember { mutableStateOf(current) }
    val matching = remember(draft, board) { board.filtered(draft).size }

    AlongsideSheet(onDismiss) {
        Column(Modifier.navigationBarsPadding()) {
            Row(Modifier.padding(start = 20.dp, end = 8.dp, top = 8.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("Narrow it down", style = Type.sheetTitle, color = c.ink, modifier = Modifier.weight(1f))
                Text(
                    "Clear all", style = Type.label.copy(textDecoration = TextDecoration.Underline), color = c.ink,
                    modifier = Modifier.heightIn(min = 44.dp).clip(RoundedCornerShape(8.dp))
                        .clickable(role = Role.Button) { draft = draft.cleared().copy(query = draft.query) }
                        .padding(horizontal = 12.dp, vertical = 14.dp),
                )
            }
            Column(
                Modifier.weight(1f, fill = false).verticalScroll(rememberScrollState()).padding(start = 20.dp, end = 20.dp, top = 8.dp),
                verticalArrangement = Arrangement.spacedBy(20.dp),
            ) {
                Column {
                    SheetLabel("Show me")
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        listOf(Show.Ready to "Ready now", Show.Focus to "Focus", Show.Waiting to "Waiting on something", Show.Napping to "Napping", Show.Someday to "Someday", Show.Done to "Done")
                            .forEach { (show, label) ->
                                FilterChip(
                                    label, selected = show in draft.show, count = board.counts.of(show), height = 40.dp, sheetStyle = true,
                                    onClick = { draft = draft.copy(show = draft.show.toggle(show).ifEmpty { setOf(Show.Ready) }) },
                                )
                            }
                    }
                }
                Column {
                    SheetLabel("When")
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        When.entries.forEach { w ->
                            FilterChip(w.label, selected = w in draft.whens, height = 40.dp, sheetStyle = true, onClick = { draft = draft.copy(whens = draft.whens.toggle(w)) })
                        }
                    }
                }
                Column {
                    SheetLabel("Project")
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        board.ws.projects.filter { it.isActive }.forEach { p ->
                            FilterChip(
                                p.title, selected = p.id in draft.projects, height = 40.dp, sheetStyle = true,
                                leading = { ProjectDot(p.id, 9.dp) },
                                onClick = { draft = draft.copy(projects = draft.projects.toggle(p.id)) },
                            )
                        }
                        FilterChip("Inbox", selected = INBOX in draft.projects, height = 40.dp, sheetStyle = true, onClick = { draft = draft.copy(projects = draft.projects.toggle(INBOX)) })
                    }
                }
                Column {
                    SheetLabel("Kind")
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Kind.entries.forEach { k ->
                            FilterChip(
                                k.label, selected = k in draft.kinds, height = 40.dp, sheetStyle = true,
                                leading = if (k == Kind.Repeating) ({ Icon(AppIcons.Repeat, null, Modifier.size(18.dp), tint = c.ink) }) else null,
                                onClick = { draft = draft.copy(kinds = draft.kinds.toggle(k)) },
                            )
                        }
                    }
                }
                Column {
                    SheetLabel("Order by")
                    Segmented(Order.entries.map { it.label }, Order.entries.indexOf(draft.order)) { draft = draft.copy(order = Order.entries[it]) }
                }
                Spacer(Modifier.height(4.dp))
            }
            Row(Modifier.padding(start = 20.dp, end = 20.dp, top = 12.dp, bottom = 24.dp)) {
                PrimaryButton(
                    when (matching) { 0 -> "Nothing matches"; 1 -> "Show 1 task"; else -> "Show $matching tasks" },
                    onClick = { onApply(draft) }, modifier = Modifier.weight(1f),
                )
            }
        }
    }
}

@Composable
fun Segmented(options: List<String>, selected: Int, onSelect: (Int) -> Unit) {
    val c = LocalColors.current
    Row(Modifier.fillMaxWidth().clip(RoundedCornerShape(14.dp)).border(1.5.dp, c.line, RoundedCornerShape(14.dp))) {
        options.forEachIndexed { i, label ->
            Box(
                Modifier.weight(1f).height(44.dp)
                    .background(if (i == selected) c.chipOnBg else c.surface.copy(alpha = 0f))
                    .clickable(role = Role.RadioButton) { onSelect(i) },
                contentAlignment = Alignment.Center,
            ) { Text(label, style = Type.label, color = if (i == selected) c.chipOnFg else c.ink) }
        }
    }
}

private enum class DueChoice(val label: String) {
    None("No date"), Today("Today"), Tomorrow("Tomorrow"), Weekend("This weekend"), NextWeek("Next week");

    fun date(): LocalDate? {
        val today = Clock.today()
        return when (this) {
            None -> null
            Today -> today
            Tomorrow -> today.plusDays(1)
            Weekend -> today.with(TemporalAdjusters.nextOrSame(DayOfWeek.SATURDAY))
            NextWeek -> today.with(TemporalAdjusters.next(DayOfWeek.MONDAY))
        }
    }
}

/** What one "Fill in" run did, kept on screen so a misread can be judged on the phone. */
private class SmartRun(
    val parserMillis: Double,
    val spans: List<String>,
    val approx: Boolean,
    val modelMillis: Long? = null,
    val attempts: Int = 0,
    val raw: String = "",
    val note: String? = null,
)

private val timeLabel = DateTimeFormatter.ofPattern("h:mm a", Locale.getDefault())

/** Quick capture: a title is enough; everything else is optional. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun NewTaskSheet(
    board: Board,
    initialProject: String?,
    quickAdd: OnDeviceQuickAdd,
    onCreate: (title: String, notes: String?, projectId: String?, plan: Boolean, due: LocalDate?, dueTime: LocalTime?, recurrence: String?) -> Unit,
    onDismiss: () -> Unit,
) {
    val c = LocalColors.current
    val scope = rememberCoroutineScope()
    var said by remember { mutableStateOf("") }
    var title by remember { mutableStateOf("") }
    var notes by remember { mutableStateOf("") }
    var project by remember { mutableStateOf(initialProject?.takeIf { it != INBOX }) }
    var plan by remember { mutableStateOf(false) }
    var due by remember { mutableStateOf(DueChoice.None) }
    // Filled in from the sentence: an exact day, a time of day and a repeat rule, each dismissable.
    var customDue by remember { mutableStateOf<LocalDate?>(null) }
    var dueTime by remember { mutableStateOf<LocalTime?>(null) }
    var recurrence by remember { mutableStateOf<String?>(null) }
    var timeNote by remember { mutableStateOf<String?>(null) }
    var availability by remember { mutableStateOf<Pair<ModelAvailability, String?>?>(null) }
    var downloadLine by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    var run by remember { mutableStateOf<SmartRun?>(null) }
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { focus.requestFocus() }
    LaunchedEffect(Unit) { availability = quickAdd.availability() }
    // A download started elsewhere (or before the sheet opened) finishes on its own; keep looking until it does.
    LaunchedEffect(availability?.first) {
        while (availability?.first == ModelAvailability.Downloading) {
            delay(3_000)
            availability = quickAdd.availability()
        }
    }
    val titleTooLong = title.trim().length > TaskLimits.TITLE_MAX
    val notesTooLong = notes.trim().length > TaskLimits.NOTES_MAX
    val canAdd = title.isNotBlank() && !titleTooLong && !notesTooLong
    val effectiveDue = customDue ?: due.date()
    // Only close once the capture is valid, so nothing typed is lost to a refusal later.
    val submit = {
        if (canAdd) {
            onCreate(title, notes, project, plan, effectiveDue, dueTime.takeIf { effectiveDue != null }, recurrence.takeIf { effectiveDue != null })
            onDismiss()
        }
    }

    // The parser answers at once; the model then fills in title, notes and kind from what is left of the sentence.
    val fill: () -> Unit = fill@{
        if (said.isBlank() || busy) return@fill
        val t0 = System.nanoTime()
        val parsed = QuickAddParser.parse(said.trim())
        val parserMillis = (System.nanoTime() - t0) / 1_000_000.0
        customDue = parsed.date
        // A repeat is date-only in the worker, so a time that came with one is left out rather than refused later.
        dueTime = parsed.time.takeIf { parsed.recurrence == null }
        timeNote = parsed.time?.takeIf { parsed.recurrence != null }?.let { "Repeats are date-only for now, so ${it.format(timeLabel)} was left out." }
        recurrence = parsed.recurrence
        title = parsed.rest
        notes = ""
        plan = false
        val spans = parsed.spans.map { "${it.kind}: ${it.text}" }
        val ready = availability?.first == ModelAvailability.Available
        if (parsed.rest.isBlank() || !ready) {
            val note = if (parsed.rest.isBlank()) "Nothing left for the model." else "On-device model not ready; the parser filled what it could."
            run = SmartRun(parserMillis, spans, parsed.approx, note = note)
            return@fill
        }
        run = SmartRun(parserMillis, spans, parsed.approx, note = "Asking the model…")
        busy = true
        val titleAtStart = title
        val notesAtStart = notes
        val planAtStart = plan
        scope.launch {
            val outcome = quickAdd.interpret(parsed.rest)
            // The fields stay editable while the model thinks; keep anything the person changed in the meantime.
            outcome.fields?.let { f ->
                if (title == titleAtStart) title = f.title
                if (notes == notesAtStart) notes = f.notes.orEmpty()
                if (plan == planAtStart) plan = f.plan
            }
            run = SmartRun(parserMillis, spans, parsed.approx, outcome.millis, outcome.attempts, outcome.raw, outcome.error)
            busy = false
        }
    }

    AlongsideSheet(onDismiss) {
        Column(Modifier.navigationBarsPadding().imePadding().padding(horizontal = 20.dp)) {
            Text("New task", style = Type.sheetTitle, color = c.ink, modifier = Modifier.padding(top = 8.dp, bottom = 12.dp))
            Column(Modifier.verticalScroll(rememberScrollState()).weight(1f, fill = false)) {
                SheetLabel("Say it your way")
                Field(said, { said = it }, "water plants every sunday at 9am", Type.body, Modifier.focusRequester(focus))
                Row(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                    FilterChip(if (busy) "Thinking…" else "Fill in", selected = false, height = 40.dp, sheetStyle = true, onClick = fill)
                    when (availability?.first) {
                        null -> Text("Checking the on-device model…", style = Type.meta, color = c.muted)
                        ModelAvailability.Available -> Text("Gemini Nano ready", style = Type.meta, color = c.muted)
                        ModelAvailability.Downloadable -> FilterChip("Download model", selected = false, height = 40.dp, sheetStyle = true, onClick = {
                            scope.launch {
                                runCatching { quickAdd.download().collect { downloadLine = it } }.onFailure { downloadLine = it.message }
                                availability = quickAdd.availability()
                            }
                        })
                        ModelAvailability.Downloading -> Text("Model is downloading…", style = Type.meta, color = c.muted)
                        ModelAvailability.Unavailable -> Text("No on-device model (${availability?.second ?: "unsupported"}). Dates and repeats still work.", style = Type.meta, color = c.muted)
                    }
                }
                downloadLine?.let { Text(it, style = Type.meta, color = c.muted, modifier = Modifier.padding(top = 4.dp)) }
                run?.let { r ->
                    Text(
                        buildString {
                            append("parser ${"%.1f".format(r.parserMillis)} ms")
                            r.modelMillis?.let { append(" · model $it ms · ${r.attempts} ${if (r.attempts == 1) "try" else "tries"}") }
                            if (r.spans.isNotEmpty()) append("\ncut: ${r.spans.joinToString("; ")}")
                            r.note?.let { append("\n$it") }
                            if (r.raw.isNotBlank()) append("\nraw: ${r.raw.trim().replace(Regex("\\s+"), " ")}")
                        },
                        style = Type.meta, color = c.muted, modifier = Modifier.padding(top = 6.dp),
                    )
                }
                Spacer(Modifier.height(14.dp))
                Field(title, { title = it }, "What needs doing?", Type.rowTitle.copy(fontSize = Type.note.fontSize))
                if (titleTooLong) LimitNote("Titles can be up to ${TaskLimits.TITLE_MAX} characters (this one is ${title.trim().length}). Longer detail fits in the notes.")
                Spacer(Modifier.height(10.dp))
                Field(notes, { notes = it }, "Notes (optional)", Type.body, singleLine = false)
                if (notesTooLong) LimitNote("Notes can be up to ${TaskLimits.NOTES_MAX} characters (these are ${notes.trim().length}).")
                Column(Modifier.padding(top = 18.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
                    Column {
                        SheetLabel("When")
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            customDue?.let { d ->
                                FilterChip(friendlyDay(d, withDayNumber = true), selected = true, height = 40.dp, sheetStyle = true, onClick = { customDue = null; dueTime = null; recurrence = null })
                            }
                            DueChoice.entries.forEach { d ->
                                FilterChip(d.label, selected = due == d && customDue == null, height = 40.dp, sheetStyle = true, onClick = { due = d; customDue = null })
                            }
                        }
                        if (effectiveDue != null && (dueTime != null || recurrence != null)) {
                            FlowRow(Modifier.padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                dueTime?.let { t -> FilterChip(t.format(timeLabel), selected = true, height = 40.dp, sheetStyle = true, onClick = { dueTime = null }) }
                                recurrence?.let { r -> FilterChip(recurrenceLabel(r) ?: "Repeats", selected = true, height = 40.dp, sheetStyle = true, onClick = { recurrence = null }) }
                            }
                        }
                        // Outside the chip row: a date-only guess ("next week", "this weekend") has no time or repeat chip.
                        if (effectiveDue != null) timeNote?.let { Text(it, style = Type.meta, color = c.muted, modifier = Modifier.padding(top = 6.dp)) }
                        if (effectiveDue != null && run?.approx == true) Text("Guessed from a vague phrase; check it, and tap a chip to drop it.", style = Type.meta, color = c.muted, modifier = Modifier.padding(top = 6.dp))
                    }
                    Column {
                        SheetLabel("Project")
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            FilterChip("Inbox", selected = project == null, height = 40.dp, sheetStyle = true, onClick = { project = null })
                            board.ws.projects.filter { it.isActive }.forEach { p ->
                                FilterChip(p.title, selected = project == p.id, height = 40.dp, sheetStyle = true, leading = { ProjectDot(p.id, 9.dp) }, onClick = { project = p.id })
                            }
                        }
                    }
                    Column {
                        SheetLabel("Kind")
                        Segmented(listOf("Action", "Plan"), if (plan) 1 else 0) { plan = it == 1 }
                    }
                }
            }
            PrimaryButton("Add task", onClick = submit, enabled = canAdd, modifier = Modifier.fillMaxWidth().padding(top = 18.dp, bottom = 24.dp))
        }
    }
}

@Composable
private fun LimitNote(text: String) {
    Text(text, style = Type.meta, color = LocalColors.current.urgentFg, modifier = Modifier.padding(top = 6.dp))
}

@Composable
private fun Field(
    value: String,
    onChange: (String) -> Unit,
    placeholder: String,
    style: TextStyle,
    modifier: Modifier = Modifier,
    singleLine: Boolean = true,
) {
    val c = LocalColors.current
    Box(
        Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).background(c.soft).padding(horizontal = 16.dp, vertical = 14.dp),
    ) {
        if (value.isEmpty()) Text(placeholder, style = style, color = c.muted)
        BasicTextField(
            value, onChange, singleLine = singleLine, minLines = if (singleLine) 1 else 2,
            textStyle = style.copy(color = c.ink), cursorBrush = SolidColor(c.ink),
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
            modifier = modifier.fillMaxWidth().semantics { contentDescription = placeholder },
        )
    }
}

/** "Nap until…": snooze presets, each with the moment it resolves to. */
@Composable
fun NapSheet(onPick: (NapChoice) -> Unit, onDismiss: () -> Unit) {
    val c = LocalColors.current
    AlongsideSheet(onDismiss) {
        Column(Modifier.navigationBarsPadding().padding(bottom = 16.dp)) {
            Text("Nap until…", style = Type.sheetTitle, color = c.ink, modifier = Modifier.padding(start = 20.dp, top = 8.dp, bottom = 8.dp))
            NapChoice.available().forEach { choice ->
                Row(
                    Modifier.fillMaxWidth().heightIn(min = 60.dp).clickable(role = Role.Button) { onPick(choice) }.padding(horizontal = 20.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(14.dp),
                ) {
                    Icon(if (choice == NapChoice.Someday) AppIcons.Moon else AppIcons.Calendar, null, Modifier.size(20.dp), tint = c.ink)
                    Column(Modifier.weight(1f)) {
                        Text(choice.label, style = Type.rowTitle.copy(fontSize = Type.body.fontSize), color = c.ink)
                        Text(choice.hint(), style = Type.meta, color = c.muted)
                    }
                }
            }
        }
    }
}
