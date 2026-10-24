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
import com.atonal440.alongside.data.TaskLimits
import com.atonal440.alongside.domain.Board
import com.atonal440.alongside.domain.Clock
import com.atonal440.alongside.domain.Filters
import com.atonal440.alongside.domain.INBOX
import com.atonal440.alongside.domain.Kind
import com.atonal440.alongside.domain.NapChoice
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

/** Quick capture: a title is enough; everything else is optional. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun NewTaskSheet(
    board: Board,
    initialProject: String?,
    onCreate: (title: String, notes: String?, projectId: String?, plan: Boolean, due: LocalDate?) -> Unit,
    onDismiss: () -> Unit,
) {
    val c = LocalColors.current
    var title by remember { mutableStateOf("") }
    var notes by remember { mutableStateOf("") }
    var project by remember { mutableStateOf(initialProject?.takeIf { it != INBOX }) }
    var plan by remember { mutableStateOf(false) }
    var due by remember { mutableStateOf(DueChoice.None) }
    val focus = remember { FocusRequester() }
    LaunchedEffect(Unit) { focus.requestFocus() }
    val titleTooLong = title.trim().length > TaskLimits.TITLE_MAX
    val notesTooLong = notes.trim().length > TaskLimits.NOTES_MAX
    val canAdd = title.isNotBlank() && !titleTooLong && !notesTooLong
    // Only close once the capture is valid, so nothing typed is lost to a refusal later.
    val submit = { if (canAdd) { onCreate(title, notes, project, plan, due.date()); onDismiss() } }

    AlongsideSheet(onDismiss) {
        Column(Modifier.navigationBarsPadding().imePadding().padding(horizontal = 20.dp)) {
            Text("New task", style = Type.sheetTitle, color = c.ink, modifier = Modifier.padding(top = 8.dp, bottom = 12.dp))
            Field(title, { title = it }, "What needs doing?", Type.rowTitle.copy(fontSize = Type.note.fontSize), Modifier.focusRequester(focus))
            if (titleTooLong) LimitNote("Titles can be up to ${TaskLimits.TITLE_MAX} characters (this one is ${title.trim().length}). Longer detail fits in the notes.")
            Spacer(Modifier.height(10.dp))
            Field(notes, { notes = it }, "Notes (optional)", Type.body, singleLine = false)
            if (notesTooLong) LimitNote("Notes can be up to ${TaskLimits.NOTES_MAX} characters (these are ${notes.trim().length}).")
            Column(Modifier.verticalScroll(rememberScrollState()).padding(top = 18.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
                Column {
                    SheetLabel("When")
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        DueChoice.entries.forEach { d -> FilterChip(d.label, selected = due == d, height = 40.dp, sheetStyle = true, onClick = { due = d }) }
                    }
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
