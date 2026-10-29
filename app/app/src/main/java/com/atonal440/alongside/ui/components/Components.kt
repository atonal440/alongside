package com.atonal440.alongside.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Outline
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import com.atonal440.alongside.domain.Clock
import com.atonal440.alongside.domain.TaskFacts
import com.atonal440.alongside.domain.friendlyDay
import com.atonal440.alongside.domain.dateLabel
import com.atonal440.alongside.domain.projectColor
import com.atonal440.alongside.domain.recurrenceLabel
import com.atonal440.alongside.ui.theme.LocalColors
import com.atonal440.alongside.ui.theme.Type
import kotlinx.coroutines.delay

/**
 * The hand-drawn pebble outline: CSS `border-radius: 52% 48% 55% 45% / 48% 55% 45% 52%`,
 * one elliptical corner per quadrant.
 */
fun pebblePath(size: Size, origin: Offset = Offset.Zero): Path {
    val (w, h) = size
    val k = 0.5523f
    val tl = Offset(.52f * w, .48f * h); val tr = Offset(.48f * w, .55f * h)
    val br = Offset(.55f * w, .45f * h); val bl = Offset(.45f * w, .52f * h)
    return Path().apply {
        moveTo(tl.x, 0f)
        cubicTo(tl.x + tr.x * k, 0f, w, tr.y - tr.y * k, w, tr.y)
        cubicTo(w, tr.y + br.y * k, w - br.x + br.x * k, h, w - br.x, h)
        cubicTo(w - br.x - bl.x * k, h, 0f, h - bl.y + bl.y * k, 0f, h - bl.y)
        cubicTo(0f, tl.y - tl.y * k, tl.x - tl.x * k, 0f, tl.x, 0f)
        close()
        translate(origin)
    }
}

object PebbleShape : Shape {
    override fun createOutline(size: Size, layoutDirection: LayoutDirection, density: Density) = Outline.Generic(pebblePath(size))
}

/**
 * The completion button. Tapping fills it lime with a check, waits a beat so the change is
 * visible, then calls [onComplete].
 */
@Composable
fun PebbleCheck(
    label: String,
    done: Boolean,
    onComplete: () -> Unit,
    modifier: Modifier = Modifier,
    size: Dp = 26.dp,
    color: Color = LocalColors.current.ink,
) {
    val c = LocalColors.current
    var pressed by remember { mutableStateOf(false) }
    val filled = done || pressed
    val fill by animateColorAsState(if (filled) c.lime else Color.Transparent, label = "pebble")
    val pop by animateFloatAsState(if (pressed) 1.12f else 1f, label = "pop")
    LaunchedEffect(pressed) {
        if (pressed) {
            delay(420)
            onComplete()
            pressed = false
        }
    }
    Box(
        modifier
            .size(44.dp)
            .clip(CircleShape)
            .clickable(enabled = !done, role = Role.Checkbox) { pressed = true }
            .semantics { contentDescription = if (done) "Done: $label" else "Complete $label" },
        contentAlignment = Alignment.Center,
    ) {
        Box(
            Modifier
                .scale(pop)
                .size(size)
                .background(fill, PebbleShape)
                .border(2.5.dp, color, PebbleShape),
            contentAlignment = Alignment.Center,
        ) {
            if (filled) Icon(AppIcons.Check, null, Modifier.size(size * 0.62f), tint = Color(0xFF1F1B3A))
        }
    }
}

/**
 * The Alongside mark, drawn on its lavender tile in the launcher icon's 108-unit grid: a big ink
 * pebble with a check, and a small peach pebble tucked in beside it.
 */
@Composable
fun AlongsideMark(modifier: Modifier = Modifier) {
    val tile = Color(0xFFCFC5F5)
    Canvas(modifier.clip(RoundedCornerShape(30)).background(tile)) {
        // Launchers show the middle 72 of the icon's 108 units, so the tile does the same.
        val s = size.minDimension / 72f
        // Same transform as the launcher foreground: scale 0.84 about (54, 56), lift by 2.
        fun p(x: Float, y: Float) = Offset((54f + (x - 54f) * 0.84f - 18f) * s, (56f + (y - 56f) * 0.84f - 2f - 18f) * s)
        fun d(v: Float) = v * 0.84f * s

        val bigOrigin = p(26f, 34f)
        val bigSize = Size(d(44f), d(38f))
        rotate(-8f, pivot = bigOrigin + Offset(bigSize.width / 2, bigSize.height / 2)) {
            drawPath(pebblePath(bigSize, bigOrigin), Color(0xFF1F1B3A))
            val check = Path().apply {
                p(38f, 53f).let { moveTo(it.x, it.y) }
                p(44.5f, 59.5f).let { lineTo(it.x, it.y) }
                p(57f, 46f).let { lineTo(it.x, it.y) }
            }
            drawPath(check, tile, style = Stroke(width = d(5f), cap = StrokeCap.Round, join = StrokeJoin.Round))
        }
        val smallOrigin = p(61f, 59f)
        val smallSize = Size(d(22f), d(20f))
        rotate(14f, pivot = smallOrigin + Offset(smallSize.width / 2, smallSize.height / 2)) {
            val small = pebblePath(smallSize, smallOrigin)
            drawPath(small, tile, style = Stroke(width = d(6f)))
            drawPath(small, Color(0xFFFF8A4C))
        }
    }
}

@Composable
fun SectionLabel(text: String, modifier: Modifier = Modifier, icon: ImageVector? = null) {
    val c = LocalColors.current
    Row(
        modifier.padding(start = 20.dp, end = 20.dp, top = 16.dp, bottom = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (icon != null) Icon(icon, null, Modifier.size(14.dp), tint = c.muted)
        Text(text.uppercase(), style = Type.section, color = c.muted)
    }
}

@Composable
fun Tag(text: String, bg: Color, fg: Color, modifier: Modifier = Modifier) {
    Text(
        text, style = Type.tag, color = fg, maxLines = 1,
        modifier = modifier.clip(RoundedCornerShape(8.dp)).background(bg).padding(horizontal = 8.dp, vertical = 3.dp),
    )
}

@Composable
fun ProjectDot(projectId: String?, size: Dp = 8.dp) {
    Box(Modifier.size(size).clip(CircleShape).background(Color(projectColor(projectId))))
}

@Composable
fun SubtaskSegments(done: Int, total: Int) {
    val c = LocalColors.current
    if (total in 1..6) {
        Row(horizontalArrangement = Arrangement.spacedBy(3.dp)) {
            repeat(total) { i ->
                Box(Modifier.size(12.dp, 6.dp).clip(RoundedCornerShape(3.dp)).background(if (i < done) c.ink else c.segOff))
            }
        }
    }
}

@Composable
fun FilterChip(
    text: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    count: Int? = null,
    height: Dp = 36.dp,
    leading: @Composable (() -> Unit)? = null,
    sheetStyle: Boolean = false,
    showCheck: Boolean = true,
) {
    val c = LocalColors.current
    val bg = when {
        !selected -> Color.Transparent
        sheetStyle -> c.lavender
        else -> c.chipOnBg
    }
    val fg = if (selected && !sheetStyle) c.chipOnFg else c.ink
    val border = when {
        !selected -> c.line
        sheetStyle -> c.ink
        else -> c.chipOnBg
    }
    Row(
        modifier
            .height(height)
            .clip(RoundedCornerShape(12.dp))
            .background(bg)
            .border(1.5.dp, border, RoundedCornerShape(12.dp))
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        if (selected && sheetStyle && showCheck) Icon(AppIcons.Check, null, Modifier.size(18.dp), tint = fg)
        leading?.invoke()
        Text(text, style = Type.label, color = fg, maxLines = 1)
        if (count != null) Text("$count", style = Type.tag, color = fg.copy(alpha = if (sheetStyle) 0.75f else 0.7f))
    }
}

@Composable
fun PrimaryButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    val c = LocalColors.current
    Box(
        modifier
            .height(56.dp)
            .alpha(if (enabled) 1f else 0.5f)
            .clip(RoundedCornerShape(18.dp))
            .background(c.peach)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(horizontal = 20.dp),
        contentAlignment = Alignment.Center,
    ) { Text(text, style = Type.button, color = c.onPeach) }
}

@Composable
fun OutlineButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val c = LocalColors.current
    Box(
        modifier
            .height(56.dp)
            .clip(RoundedCornerShape(18.dp))
            .border(BorderStroke(1.5.dp, c.line), RoundedCornerShape(18.dp))
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 20.dp),
        contentAlignment = Alignment.Center,
    ) { Text(text, style = Type.button.copy(fontSize = Type.label.fontSize * 15 / 14), color = c.ink) }
}

@Composable
fun IconBtn(icon: ImageVector, label: String, onClick: () -> Unit, modifier: Modifier = Modifier, tint: Color = LocalColors.current.ink, size: Dp = 20.dp) {
    Box(
        modifier.size(48.dp).clip(CircleShape).clickable(role = Role.Button, onClick = onClick).semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) { Icon(icon, null, Modifier.size(size), tint = tint) }
}

/** A folded group at the bottom of the list ("Napping until Thursday · 2"). */
@Composable
fun FoldRow(icon: ImageVector, text: String, count: Int, onClick: () -> Unit, modifier: Modifier = Modifier) {
    val c = LocalColors.current
    Row(
        modifier
            .padding(horizontal = 16.dp)
            .fillMaxWidth()
            .height(48.dp)
            .clip(RoundedCornerShape(14.dp))
            .background(c.soft)
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        Icon(icon, null, Modifier.size(18.dp), tint = c.ink)
        Row(Modifier.weight(1f)) {
            Text(text, style = Type.label, color = c.ink)
            Text(" · $count", style = Type.label, color = c.muted)
        }
        Icon(AppIcons.ChevronRight, null, Modifier.size(18.dp), tint = c.ink)
    }
}

/** One task in the list: pebble, title, and a wrapping line of facts. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun TaskRow(
    facts: TaskFacts,
    projectTitle: String?,
    onOpen: () -> Unit,
    onComplete: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = LocalColors.current
    val task = facts.task
    Row(
        modifier
            .fillMaxWidth()
            .heightIn(min = 64.dp)
            .clickable(onClick = onOpen)
            .padding(start = 8.dp, end = 16.dp, top = 8.dp, bottom = 8.dp),
        horizontalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        PebbleCheck(task.title, done = facts.isDone, onComplete = onComplete)
        Column(Modifier.weight(1f).padding(top = 9.dp)) {
            Text(
                task.title, style = Type.rowTitle,
                color = if (facts.isDone) c.muted else c.ink,
                textDecoration = if (facts.isDone) TextDecoration.LineThrough else null,
                maxLines = 3, overflow = TextOverflow.Ellipsis,
            )
            Spacer(Modifier.height(6.dp))
            FlowRow(
                horizontalArrangement = Arrangement.spacedBy(10.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp),
                itemVerticalAlignment = Alignment.CenterVertically,
            ) {
                facts.dateLabel()?.let { label ->
                    if (label.urgent) Tag(label.text, c.urgentBg, c.urgentFg) else MetaText(label.text)
                }
                if (facts.isNapping) facts.deferUntil?.let { MetaWithIcon(AppIcons.Moon, "Back ${friendlyDay(it.atZone(Clock.zone).toLocalDate())}") }
                if (facts.isBlocked) MetaWithIcon(AppIcons.Lock, "Blocked")
                if (task.isPlan) Tag("Plan", c.planBg, c.planFg)
                if (facts.subtasks.isNotEmpty()) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        SubtaskSegments(facts.subtasksDone, facts.subtasks.size)
                        MetaText("${facts.subtasksDone}/${facts.subtasks.size}")
                    }
                }
                recurrenceLabel(task)?.let { MetaWithIcon(AppIcons.Repeat, it) }
                ProjectMeta(task.project_id, projectTitle)
            }
        }
    }
}

@Composable
private fun MetaText(text: String) {
    Text(text, style = Type.meta, color = LocalColors.current.muted)
}

@Composable
private fun MetaWithIcon(icon: ImageVector, text: String) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Icon(icon, null, Modifier.size(14.dp), tint = LocalColors.current.muted)
        MetaText(text)
    }
}

@Composable
fun ProjectMeta(projectId: String?, title: String?) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        if (title != null) ProjectDot(projectId)
        MetaText(title ?: "Inbox")
    }
}

@Composable
fun RowScope.Grow() = Spacer(Modifier.weight(1f))

@Composable
fun WidthSpacer(width: Dp) = Spacer(Modifier.width(width))
