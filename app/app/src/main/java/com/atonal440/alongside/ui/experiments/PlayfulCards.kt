package com.atonal440.alongside.ui.experiments

import android.graphics.Matrix
import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.wrapContentSize
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Rect
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.PathOperation
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.sp
import androidx.compose.ui.zIndex
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.unit.Dp
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialShapes
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.draw.scale
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Outline
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.graphics.asComposePath
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import androidx.graphics.shapes.Morph
import androidx.graphics.shapes.toPath
import com.atonal440.alongside.data.SampleData
import com.atonal440.alongside.domain.Board
import com.atonal440.alongside.domain.TaskFacts
import com.atonal440.alongside.domain.dateLabel
import com.atonal440.alongside.domain.projectColor
import com.atonal440.alongside.domain.recurrenceLabel
import com.atonal440.alongside.ui.components.AppIcons
import com.atonal440.alongside.ui.components.SubtaskSegments
import com.atonal440.alongside.ui.components.Tag
import com.atonal440.alongside.ui.theme.AlongsideTheme
import com.atonal440.alongside.ui.theme.LocalColors
import com.atonal440.alongside.ui.theme.Type

/*
 * Playful redesign of the whole task list: each task is a chunky card tinted with its project's
 * color, cards sit at tiny alternating angles, they squish when pressed, and the check is a blob
 * that morphs into a cookie with a spring when you complete it. Preview-only for now; nothing
 * here is used by a screen. Use Interactive mode on "Playful list" to feel it.
 */

/** A [Shape] that draws a [Morph] at [progress] (0 = start, 1 = end), scaled to the box. */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
private class MorphShape(private val morph: Morph, private val progress: Float) : Shape {
    override fun createOutline(size: Size, layoutDirection: LayoutDirection, density: Density): Outline {
        val path = morph.toPath(progress)
        val matrix = Matrix().apply { setScale(size.width, size.height) }
        path.transform(matrix)
        return Outline.Generic(path.asComposePath())
    }
}

@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun SquishyCheck(label: String, done: Boolean, onToggle: () -> Unit) {
    val c = LocalColors.current
    val morph = remember { Morph(MaterialShapes.Circle, MaterialShapes.Cookie9Sided) }
    val progress by animateFloatAsState(if (done) 1f else 0f, MaterialTheme.motionScheme.defaultSpatialSpec(), label = "morph")
    val pop by animateFloatAsState(if (done) 1.12f else 1f, MaterialTheme.motionScheme.fastSpatialSpec(), label = "pop")
    val fill by animateColorAsState(if (done) c.lime else Color.Transparent, MaterialTheme.motionScheme.defaultEffectsSpec(), label = "fill")
    Box(
        Modifier
            .size(52.dp)
            .scale(pop)
            .clip(MorphShape(morph, progress.coerceIn(0f, 1f)))
            .background(fill)
            .clickable(role = Role.Checkbox, onClick = onToggle)
            .padding(2.dp),
        contentAlignment = Alignment.Center,
    ) {
        if (!done) Box(Modifier.size(52.dp).clip(MorphShape(morph, 0f)).background(c.ink.copy(alpha = 0.12f)))
        if (done) Icon(AppIcons.Check, label, Modifier.size(26.dp), tint = Color(0xFF1F1B3A))
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun PlayfulCard(facts: TaskFacts, index: Int, modifier: Modifier = Modifier) {
    val c = LocalColors.current
    val task = facts.task
    var done by remember { mutableStateOf(facts.isDone) }
    val source = remember { MutableInteractionSource() }
    val pressed by source.collectIsPressedAsState()
    val squish by animateFloatAsState(if (pressed) 0.96f else 1f, MaterialTheme.motionScheme.fastSpatialSpec(), label = "squish")
    val tint = Color(projectColor(task.project_id))
    val tilt = if (index % 2 == 0) -0.7f else 0.7f
    Row(
        modifier
            .fillMaxWidth()
            .padding(horizontal = 14.dp, vertical = 6.dp)
            .rotate(if (pressed) 0f else tilt)
            .scale(squish)
            .clip(RoundedCornerShape(32.dp))
            .background(tint.copy(alpha = if (c.isDark) 0.28f else 0.22f))
            .clickable(interactionSource = source, indication = null, role = Role.Button) {}
            .padding(horizontal = 14.dp, vertical = 14.dp),
        horizontalArrangement = Arrangement.spacedBy(14.dp),
        verticalAlignment = Alignment.Top,
    ) {
        SquishyCheck(task.title, done) { done = !done }
        Column(Modifier.weight(1f)) {
            Text(
                task.title, style = Type.note.copy(fontSize = Type.rowTitle.fontSize * 1.1f),
                color = if (done) c.muted else c.ink,
                textDecoration = if (done) TextDecoration.LineThrough else null,
                maxLines = 3, overflow = TextOverflow.Ellipsis,
            )
            Spacer(Modifier.height(8.dp))
            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                facts.dateLabel()?.let { label ->
                    if (label.urgent) Tag(label.text, c.urgentBg, c.urgentFg) else Tag(label.text, c.card, c.muted)
                }
                if (task.isPlan) Tag("Plan", c.planBg, c.planFg)
                if (facts.subtasks.isNotEmpty()) {
                    Row(Modifier.clip(RoundedCornerShape(8.dp)).background(c.card).padding(horizontal = 8.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        SubtaskSegments(facts.subtasksDone, facts.subtasks.size)
                        Text("${facts.subtasksDone}/${facts.subtasks.size}", style = Type.tag, color = c.muted)
                    }
                }
                recurrenceLabel(task)?.let { Tag(it, c.card, c.muted) }
            }
        }
    }
}

@Composable
private fun PlayfulList() {
    val c = LocalColors.current
    val board = remember { Board(SampleData.workspace()) }
    Column(Modifier.background(c.ground).padding(vertical = 12.dp)) {
        Text("READY NOW", style = Type.section, color = c.muted, modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp))
        board.facts.take(5).forEachIndexed { i, f -> PlayfulCard(f, i) }
    }
}

@Preview(name = "Playful list", widthDp = 380, showBackground = true)
@Composable
private fun PlayfulListPreview() = AlongsideTheme(darkTheme = false, expressive = true) { PlayfulList() }

@Preview(name = "Playful list, dark", widthDp = 380, showBackground = true)
@Composable
private fun PlayfulListDarkPreview() = AlongsideTheme(darkTheme = true, expressive = true) { PlayfulList() }

/* ---------------------------------------------------------------------------------------------
 * Carnival-ticket variant (adapted from the "Ticket stacks" artboard on the design canvas).
 * A ticket has half-circle notches at its corners and at both ends of a perforation, a dashed
 * perforation line, a stub on the right (date + how many "folds" - subtasks - are left), and
 * paper folds peeking out below, one per remaining subtask. Completing stamps it DONE.
 * ------------------------------------------------------------------------------------------- */

/** Rectangle with rounded notch cut-outs at the four corners and at [perfFromEnd] on top and bottom. */
private class TicketShape(private val cornerNotch: Dp, private val perfNotch: Dp, private val perfFromEnd: Dp) : Shape {
    override fun createOutline(size: Size, layoutDirection: LayoutDirection, density: Density): Outline {
        val cr = with(density) { cornerNotch.toPx() }
        val pr = with(density) { perfNotch.toPx() }
        val px = size.width - with(density) { perfFromEnd.toPx() }
        var path = Path().apply { addRect(Rect(0f, 0f, size.width, size.height)) }
        fun cut(x: Float, y: Float, r: Float) {
            val hole = Path().apply { addOval(Rect(Offset(x, y), r)) }
            path = Path.combine(PathOperation.Difference, path, hole)
        }
        listOf(0f to 0f, size.width to 0f, 0f to size.height, size.width to size.height).forEach { (x, y) -> cut(x, y, cr) }
        cut(px, 0f, pr); cut(px, size.height, pr)
        return Outline.Generic(path)
    }
}

private val StubMono = TextStyle(fontFamily = FontFamily.Monospace, fontWeight = FontWeight.Medium, fontSize = 12.sp, lineHeight = 14.sp, letterSpacing = 0.5.sp)

@Composable
private fun TicketCard(facts: TaskFacts, index: Int, modifier: Modifier = Modifier) {
    val c = LocalColors.current
    val task = facts.task
    var done by remember { mutableStateOf(facts.isDone) }
    val source = remember { MutableInteractionSource() }
    val pressed by source.collectIsPressedAsState()
    val squish by animateFloatAsState(if (pressed) 0.97f else 1f, MaterialTheme.motionScheme.fastSpatialSpec(), label = "squish")
    val tint = Color(projectColor(task.project_id))
    val folds = (facts.subtasks.size - facts.subtasksDone).coerceIn(0, 3)
    val shape = remember { TicketShape(cornerNotch = 11.dp, perfNotch = 9.dp, perfFromEnd = 80.dp) }
    val label = facts.dateLabel()
    Column(modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 7.dp).scale(squish)) {
        Box(Modifier.zIndex(1f)) {
            Row(
                Modifier
                    .fillMaxWidth()
                    .shadow(3.dp, shape)
                    .clip(shape)
                    .background(c.card)
                    .clickable(interactionSource = source, indication = null, role = Role.Button) { done = !done }
                    .height(IntrinsicSize.Min),
            ) {
                Column(Modifier.weight(1f).padding(start = 16.dp, end = 12.dp, top = 14.dp, bottom = 14.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        task.title, style = Type.rowTitle,
                        color = if (done) c.muted else c.ink,
                        textDecoration = if (done) TextDecoration.LineThrough else null,
                        maxLines = 3, overflow = TextOverflow.Ellipsis,
                    )
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Box(Modifier.size(8.dp).clip(CircleShape).background(tint))
                        Text(if (task.isPlan) "Plan" else "Task", style = Type.tag, color = c.muted)
                        recurrenceLabel(task)?.let { Text("· $it", style = Type.tag, color = c.muted) }
                    }
                }
                Column(
                    Modifier
                        .width(80.dp)
                        .fillMaxHeight()
                        .background(tint.copy(alpha = if (c.isDark) 0.30f else 0.26f))
                        .drawBehind {
                            drawLine(c.line, Offset(0f, 12.dp.toPx()), Offset(0f, size.height - 12.dp.toPx()), strokeWidth = 2.dp.toPx(),
                                cap = StrokeCap.Round, pathEffect = PathEffect.dashPathEffect(floatArrayOf(6.dp.toPx(), 5.dp.toPx())))
                        }
                        .padding(8.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.SpaceBetween,
                ) {
                    Text((label?.text ?: "Any day").uppercase(), style = StubMono, color = if (label?.urgent == true) c.urgentFg else c.ink, maxLines = 2, textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                    Text(if (facts.subtasks.isEmpty()) "" else "${facts.subtasks.size - facts.subtasksDone} folds", style = StubMono.copy(fontSize = 11.sp), color = c.muted)
                }
            }
            if (done) {
                Text(
                    "DONE", style = StubMono.copy(fontSize = 15.sp, letterSpacing = 2.sp), color = Color(0xFF2E7D32),
                    modifier = Modifier.align(Alignment.CenterEnd).padding(end = 96.dp).rotate(-9f)
                        .background(c.card.copy(alpha = 0.85f), RoundedCornerShape(8.dp))
                        .border(2.5.dp, Color(0xFF2E7D32), RoundedCornerShape(8.dp)).padding(horizontal = 8.dp, vertical = 3.dp),
                )
            }
        }
        // Folds peeking out beneath the ticket: one per subtask left (max 3).
        repeat(if (done) 0 else folds) { k ->
            Box(
                Modifier.fillMaxWidth().padding(horizontal = (8 * (k + 1)).dp).height(8.dp).offset(y = (-2 - k).dp)
                    .clip(RoundedCornerShape(bottomStart = 6.dp, bottomEnd = 6.dp))
                    .background(c.card.copy(alpha = 0.85f - 0.2f * k)).border(1.dp, c.line, RoundedCornerShape(bottomStart = 6.dp, bottomEnd = 6.dp)),
            )
        }
    }
}

@Composable
private fun TicketList() {
    val c = LocalColors.current
    val board = remember { Board(SampleData.workspace()) }
    Column(Modifier.background(c.ground).padding(vertical = 12.dp)) {
        Text("YOUR STACK", style = Type.section, color = c.muted, modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp))
        board.facts.take(5).forEachIndexed { i, f -> TicketCard(f, i) }
    }
}

@Preview(name = "Ticket list", widthDp = 380, showBackground = true)
@Composable
private fun TicketListPreview() = AlongsideTheme(darkTheme = false, expressive = true) { TicketList() }

@Preview(name = "Ticket list, dark", widthDp = 380, showBackground = true)
@Composable
private fun TicketListDarkPreview() = AlongsideTheme(darkTheme = true, expressive = true) { TicketList() }
