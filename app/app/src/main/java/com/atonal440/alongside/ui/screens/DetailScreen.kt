package com.atonal440.alongside.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import com.atonal440.alongside.data.Task
import com.atonal440.alongside.domain.Board
import com.atonal440.alongside.domain.Clock
import com.atonal440.alongside.domain.TaskFacts
import com.atonal440.alongside.domain.TemporalPoint
import com.atonal440.alongside.domain.displayDate
import com.atonal440.alongside.domain.dateLabel
import com.atonal440.alongside.domain.friendlyDay
import com.atonal440.alongside.domain.friendlyTime
import com.atonal440.alongside.domain.recurrenceLabel
import com.atonal440.alongside.ui.components.AppIcons
import com.atonal440.alongside.ui.components.IconBtn
import com.atonal440.alongside.ui.components.OutlineButton
import com.atonal440.alongside.ui.components.PebbleCheck
import com.atonal440.alongside.ui.components.PrimaryButton
import com.atonal440.alongside.ui.components.ProjectDot
import com.atonal440.alongside.ui.components.Tag
import com.atonal440.alongside.ui.theme.LocalColors
import com.atonal440.alongside.ui.theme.Type
import java.time.Instant

@Composable
fun DetailScreen(
    board: Board,
    taskId: String,
    onBack: () -> Unit,
    onOpenTask: (String) -> Unit,
    onComplete: (String) -> Unit,
    onToggleFocus: (Boolean) -> Unit,
    onNap: () -> Unit,
    onWake: () -> Unit,
    onSomeday: () -> Unit,
    onDelete: () -> Unit,
) {
    val c = LocalColors.current
    val facts = board.facts(taskId)
    if (facts == null) {
        Column(Modifier.fillMaxSize().background(c.ground).statusBarsPadding()) {
            IconBtn(AppIcons.Back, "Back", onBack, Modifier.padding(8.dp))
            EmptyNote("This task isn't here any more.")
        }
        return
    }
    val task = facts.task
    val project = board.ws.project(task.project_id)
    val parent = task.parent_id?.let { board.ws.task(it) }
    var menu by remember { mutableStateOf(false) }

    Column(Modifier.fillMaxSize().background(c.ground).statusBarsPadding().navigationBarsPadding()) {
        Row(Modifier.padding(start = 8.dp, end = 8.dp, top = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            IconBtn(AppIcons.Back, "Back", onBack)
            Spacer(Modifier.weight(1f))
            if (!facts.isDone && !facts.isDeferred) {
                IconBtn(
                    if (facts.isFocused) AppIcons.StarFilled else AppIcons.Star,
                    if (facts.isFocused) "Stop focusing on this task" else "Focus on this task",
                    onClick = { onToggleFocus(!facts.isFocused) },
                    tint = if (facts.isFocused) c.peach else c.ink,
                )
            }
            Box {
                IconBtn(AppIcons.More, "More options", onClick = { menu = true })
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    if (!facts.isSomeday && !facts.isDone) DropdownMenuItem(text = { Text("Move to someday") }, leadingIcon = { Icon(AppIcons.Moon, null, Modifier.size(18.dp)) }, onClick = { menu = false; onSomeday() })
                    DropdownMenuItem(text = { Text("Delete task") }, leadingIcon = { Icon(AppIcons.Trash, null, Modifier.size(18.dp)) }, onClick = { menu = false; onDelete() })
                }
            }
        }

        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            if (parent != null) {
                Text(
                    "Part of: ${parent.title}", style = Type.label, color = c.muted,
                    modifier = Modifier.padding(horizontal = 20.dp).clip(RoundedCornerShape(8.dp)).clickable { onOpenTask(parent.id) }.padding(vertical = 6.dp),
                )
            }
            Text(
                task.title, style = Type.title, color = c.ink,
                textDecoration = if (facts.isDone) TextDecoration.LineThrough else null,
                modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 4.dp),
            )
            Row(Modifier.padding(start = 20.dp, end = 20.dp, top = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                facts.dateLabel()?.let { if (it.urgent) Tag(it.text, c.urgentBg, c.urgentFg) else Tag(it.text, c.soft, c.muted) }
                if (task.isPlan) Tag("Plan", c.planBg, c.planFg)
                when {
                    facts.isDone -> Tag("Done", c.lime, c.onPeach)
                    facts.isSomeday -> Tag("Someday", c.soft, c.muted)
                    facts.isNapping -> Tag("Napping", c.soft, c.muted)
                    facts.isWaiting -> Tag("Waiting", c.soft, c.muted)
                }
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (project != null) ProjectDot(project.id, 9.dp)
                    Text(project?.title ?: "Inbox", style = Type.label.copy(fontSize = Type.meta.fontSize * 13 / 12.5), color = c.muted)
                }
            }

            val next = facts.subtasks.firstOrNull { !it.isDone }
            if (task.kickoff_note != null || next != null) KickoffCard(task.kickoff_note, next)

            if (facts.subtasks.isNotEmpty()) {
                DetailLabel("Subtasks · ${facts.subtasksDone} of ${facts.subtasks.size}")
                Card(Modifier.padding(start = 4.dp, end = 12.dp)) {
                    facts.subtasks.forEach { sub ->
                        Row(Modifier.fillMaxWidth().heightIn(min = 44.dp).clickable { onOpenTask(sub.id) }, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(2.dp)) {
                            PebbleCheck(sub.title, done = sub.isDone, onComplete = { onComplete(sub.id) })
                            Text(
                                sub.title, style = Type.rowTitle.copy(fontSize = Type.body.fontSize), modifier = Modifier.weight(1f),
                                color = if (sub.isDone) c.muted else c.ink,
                                textDecoration = if (sub.isDone) TextDecoration.LineThrough else null,
                            )
                            if (sub == next) Tag("Next", c.urgentBg, c.urgentFg)
                        }
                    }
                }
            }

            val details = detailFacts(facts)
            if (details.isNotEmpty() || !task.notes.isNullOrBlank()) {
                DetailLabel("The details")
                Card {
                    details.forEachIndexed { i, (icon, label, value) ->
                        if (i > 0) HorizontalDivider(color = c.divider)
                        Fact(icon, label, value)
                    }
                    if (!task.notes.isNullOrBlank()) {
                        if (details.isNotEmpty()) HorizontalDivider(color = c.divider)
                        Fact(AppIcons.Notes, "Notes", task.notes)
                    }
                }
            }
            Spacer(Modifier.height(16.dp))
        }

        if (!facts.isDone) {
            Row(Modifier.padding(start = 16.dp, end = 16.dp, top = 12.dp, bottom = 24.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                PrimaryButton("Mark done", onClick = { onComplete(task.id) }, modifier = Modifier.weight(1f))
                if (facts.isDeferred) OutlineButton("Wake it up", onClick = onWake) else OutlineButton("Nap until…", onClick = onNap)
            }
        }
    }
}

@Composable
private fun KickoffCard(note: String?, next: Task?) {
    val c = LocalColors.current
    Column(
        Modifier.padding(start = 16.dp, end = 16.dp, top = 14.dp).fillMaxWidth()
            .clip(RoundedCornerShape(24.dp)).background(c.noteBg).padding(16.dp),
    ) {
        if (note != null) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Icon(AppIcons.Flag, null, Modifier.size(16.dp), tint = c.noteAccent)
                Text("KICKOFF NOTE", style = Type.section, color = c.noteAccent)
            }
            Text(note, style = Type.note, color = c.noteFg, modifier = Modifier.padding(top = 10.dp))
        }
        if (next != null) {
            val rule = c.noteRule
            Column(
                Modifier.padding(top = if (note != null) 14.dp else 0.dp).fillMaxWidth().drawBehind {
                    if (note != null) drawLine(rule, Offset.Zero, Offset(size.width, 0f), strokeWidth = 1.5.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(6f, 6f)))
                }.padding(top = if (note != null) 12.dp else 0.dp),
            ) {
                Text("NEXT STEP · ${next.title.uppercase()}", style = Type.section.copy(lineHeight = Type.tag.lineHeight), color = c.noteMuted)
                next.notes?.takeIf { it.isNotBlank() }?.let {
                    Text(it, style = Type.body, color = c.noteFg, modifier = Modifier.padding(top = 6.dp))
                }
            }
        }
    }
}

@Composable
private fun DetailLabel(text: String) {
    Text(text.uppercase(), style = Type.section, color = LocalColors.current.muted, modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 18.dp, bottom = 8.dp))
}

@Composable
private fun Card(modifier: Modifier = Modifier, content: @Composable () -> Unit) {
    val c = LocalColors.current
    Column(Modifier.padding(horizontal = 16.dp).fillMaxWidth().clip(RoundedCornerShape(20.dp)).background(c.card).then(modifier).padding(horizontal = 16.dp, vertical = 4.dp)) {
        content()
    }
}

@Composable
private fun Fact(icon: ImageVector, label: String, value: String) {
    val c = LocalColors.current
    Row(Modifier.fillMaxWidth().heightIn(min = 52.dp).padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(14.dp)) {
        Icon(icon, null, Modifier.size(20.dp), tint = c.ink)
        Column {
            Text(label, style = Type.meta, color = c.muted)
            Spacer(Modifier.height(3.dp))
            Text(value, style = Type.rowTitle.copy(fontSize = Type.body.fontSize), color = c.ink)
        }
    }
}

private fun dayAndTime(at: Instant, allDay: Boolean): String {
    val day = friendlyDay(at.atZone(Clock.zone).toLocalDate(), withDayNumber = true)
    return if (allDay) day else "$day, ${friendlyTime(at)}"
}

private fun detailFacts(f: TaskFacts): List<Triple<ImageVector, String, String>> = buildList {
    f.target?.let { add(Triple(AppIcons.Calendar, "Aiming for", dayAndTime(it, f.targetAllDay))) }
    f.deadlinePoint?.let { point ->
        val day = friendlyDay(point.displayDate(), withDayNumber = true)
        add(Triple(AppIcons.Flag, "Deadline", if (point is TemporalPoint.At) "$day, ${friendlyTime(point.at, point.zone)}" else day))
    }
    f.opensAt?.let { if (f.notYetOpen) add(Triple(AppIcons.Lock, "Opens", dayAndTime(it, false))) }
    if (f.isNapping) f.deferUntil?.let { add(Triple(AppIcons.Moon, "Napping until", dayAndTime(it, false))) }
    recurrenceLabel(f.task)?.let { add(Triple(AppIcons.Repeat, "Repeats", it)) }
}
