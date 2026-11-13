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
import androidx.compose.ui.layout.layout
import androidx.compose.ui.draw.clipToBounds
import kotlin.math.roundToInt
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.foundation.gestures.detectHorizontalDragGestures
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.foundation.layout.requiredWidth
import androidx.compose.ui.graphics.graphicsLayer
import kotlin.math.PI
import kotlinx.coroutines.launch
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt
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
private fun SquishyCheck(label: String, done: Boolean, boxSize: androidx.compose.ui.unit.Dp = 52.dp, onToggle: () -> Unit) {
    val c = LocalColors.current
    val morph = remember { Morph(MaterialShapes.Circle, MaterialShapes.Cookie9Sided) }
    val progress by animateFloatAsState(if (done) 1f else 0f, MaterialTheme.motionScheme.defaultSpatialSpec(), label = "morph")
    val pop by animateFloatAsState(if (done) 1.12f else 1f, MaterialTheme.motionScheme.fastSpatialSpec(), label = "pop")
    val fill by animateColorAsState(if (done) c.lime else Color.Transparent, MaterialTheme.motionScheme.defaultEffectsSpec(), label = "fill")
    Box(
        Modifier
            .size(boxSize)
            .scale(pop)
            .clip(MorphShape(morph, progress.coerceIn(0f, 1f)))
            .background(fill)
            .clickable(role = Role.Checkbox, onClick = onToggle)
            .padding(2.dp),
        contentAlignment = Alignment.Center,
    ) {
        if (!done) Box(Modifier.size(boxSize).clip(MorphShape(morph, 0f)).background(c.ink.copy(alpha = 0.12f)))
        if (done) Icon(AppIcons.Check, label, Modifier.size(boxSize / 2), tint = Color(0xFF1F1B3A))
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
    val shownFolds = if (done) 0 else folds
    Column(modifier.fillMaxWidth().padding(start = 16.dp, end = 16.dp, top = 7.dp, bottom = 7.dp + (6 * shownFolds).dp).scale(squish)) {
        Box {
            // Folds peeking out beneath: same notched shape as the top ticket (corners + perforation), one per subtask left.
            for (k in shownFolds - 1 downTo 0) {
                val inset = 8 * (k + 1)
                val foldShape = remember(inset) { TicketShape(cornerNotch = 11.dp, perfNotch = 9.dp, perfFromEnd = (80 - inset).dp) }
                Box(
                    Modifier.matchParentSize().padding(horizontal = inset.dp).offset(y = (6 * (k + 1)).dp)
                        .clip(foldShape)
                        .background(androidx.compose.ui.graphics.lerp(c.card, c.ground, 0.12f * (k + 1)))
                        .border(1.dp, c.line, foldShape),
                )
            }
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

/**
 * Hole-punch check for the ticket: an empty ring that, when checked, springs into a dark cookie-shaped
 * punched hole with a check mark in it. No ripple or hover overlay (those read as a stray shadow).
 */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun PunchCheck(label: String, done: Boolean, boxSize: androidx.compose.ui.unit.Dp = 44.dp, onToggle: () -> Unit) {
    val c = LocalColors.current
    val morph = remember { Morph(MaterialShapes.Circle, MaterialShapes.Cookie9Sided) }
    val progress by animateFloatAsState(if (done) 1f else 0f, MaterialTheme.motionScheme.defaultSpatialSpec(), label = "punch")
    val pop by animateFloatAsState(if (done) 1.1f else 1f, MaterialTheme.motionScheme.fastSpatialSpec(), label = "punchPop")
    val fill by animateColorAsState(if (done) c.ink else Color.Transparent, MaterialTheme.motionScheme.defaultEffectsSpec(), label = "punchFill")
    val ring by animateColorAsState(if (done) c.ink else c.muted, MaterialTheme.motionScheme.defaultEffectsSpec(), label = "punchRing")
    val shape = MorphShape(morph, progress.coerceIn(0f, 1f))
    Box(
        Modifier
            .size(boxSize)
            .scale(pop)
            .clip(shape)
            .background(fill)
            .border(2.dp, ring, shape)
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null, role = Role.Checkbox, onClick = onToggle),
        contentAlignment = Alignment.Center,
    ) {
        if (done) Icon(AppIcons.Check, label, Modifier.size(boxSize / 2), tint = c.card)
    }
}

/* ---------------------------------------------------------------------------------------------
 * Soft ticket: rounder, friendlier take. Two pieces (body + stub) separated by a small gap; the
 * facing corners are scooped (concave) with smooth filleted joins instead of hard semicircle bites,
 * and the outer corners are generously rounded like other Material 3 Expressive containers.
 * ------------------------------------------------------------------------------------------- */

/** Rounded rect whose left and/or right corners can be scooped inward with tangent-continuous curves. */
private class SoftPieceShape(
    private val outer: Dp, private val scoop: Dp, private val fillet: Dp,
    private val scoopLeft: Boolean, private val scoopRight: Boolean,
) : Shape {
    override fun createOutline(size: Size, layoutDirection: LayoutDirection, density: Density): Outline {
        val w = size.width; val h = size.height
        val rad = minOf(with(density) { outer.toPx() }, h / 2f, w / 2f)
        val r = with(density) { scoop.toPx() }
        val f = with(density) { fillet.toPx() }
        val dx = sqrt(r * r + 2 * r * f)
        val path = Path()
        var started = false
        // Corner position, incoming heading u, outgoing heading v (clockwise traversal), concave?
        class Corner(val x: Float, val y: Float, val ux: Float, val uy: Float, val vx: Float, val vy: Float, val concave: Boolean)
        val corners = listOf(
            Corner(0f, 0f, 0f, -1f, 1f, 0f, scoopLeft), Corner(w, 0f, 1f, 0f, 0f, 1f, scoopRight),
            Corner(w, h, 0f, 1f, -1f, 0f, scoopRight), Corner(0f, h, -1f, 0f, 0f, -1f, scoopLeft),
        )
        fun pt(c: Corner, lx: Float, ly: Float) {
            val px = c.x + lx * c.ux + ly * c.vx
            val py = c.y + lx * c.uy + ly * c.vy
            if (!started) { path.moveTo(px, py); started = true } else path.lineTo(px, py)
        }
        fun arc(c: Corner, cx: Float, cy: Float, radius: Float, a0: Double, a1: Double) {
            val n = 14
            for (i in 0..n) {
                val a = a0 + (a1 - a0) * i / n
                pt(c, cx + radius * cos(a).toFloat(), cy + radius * sin(a).toFloat())
            }
        }
        val half = PI / 2
        corners.forEach { c ->
            if (!c.concave) {
                arc(c, -rad, rad, rad, -half, 0.0)
            } else {
                val phi = atan2((-f).toDouble(), dx.toDouble())
                val psi = atan2(f.toDouble(), (-dx).toDouble())
                val psi2 = atan2(dx.toDouble(), (-f).toDouble())
                val phi2 = atan2((-dx).toDouble(), f.toDouble())
                arc(c, -dx, f, f, -half, phi)
                arc(c, 0f, 0f, r, psi, psi2)
                arc(c, -f, dx, f, phi2, 0.0)
            }
        }
        path.close()
        return Outline.Generic(path)
    }
}

@Composable
private fun SoftTicketCard(facts: TaskFacts, index: Int, modifier: Modifier = Modifier) {
    val c = LocalColors.current
    val task = facts.task
    var done by remember { mutableStateOf(facts.isDone) }
    var torn by remember { mutableStateOf(false) }   // stub torn off: a separate step after checking off
    var dragPx by remember { mutableStateOf(0f) }
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    var grabBody by remember { mutableStateOf(false) }   // which piece the finger is holding
    var dragging by remember { mutableStateOf(false) }
    val lift by animateFloatAsState(if (dragging) 1f else 0f, MaterialTheme.motionScheme.fastSpatialSpec(), label = "lift")
    // The moment the stub is torn, the ticket heads off screen to the left while the stub goes right; then the row collapses.
    val slide by animateFloatAsState(if (torn) 1f else 0f, androidx.compose.animation.core.tween(520, easing = androidx.compose.animation.core.CubicBezierEasing(0.6f, -0.3f, 0.75f, 0.45f)), label = "slide")
    val shrink by animateFloatAsState(if (torn) 1f else 0f, androidx.compose.animation.core.tween(300, delayMillis = if (torn) 420 else 0), label = "shrink")
    val source = remember { MutableInteractionSource() }
    val pressed by source.collectIsPressedAsState()
    val squish by animateFloatAsState(if (pressed) 0.97f else 1f, MaterialTheme.motionScheme.fastSpatialSpec(), label = "squish")
    val tint = Color(projectColor(task.project_id))
    val left = facts.subtasks.size - facts.subtasksDone
    val shownFolds = if (done) 0 else left.coerceIn(0, 3)
    val bodyShape = remember { SoftPieceShape(24.dp, 10.dp, 5.dp, scoopLeft = false, scoopRight = true) }
    val stubShape = remember { SoftPieceShape(24.dp, 10.dp, 5.dp, scoopLeft = true, scoopRight = false) }
    val label = facts.dateLabel()
    val stubW = 76.dp
    val gap = 4.dp
    val stubTint = tint.copy(alpha = if (c.isDark) 0.30f else 0.26f)
    // Tear-off: the stub winds back slightly, then flies off to the right; afterwards its slot collapses.
    val tear by animateFloatAsState(if (torn) 1f else 0f, androidx.compose.animation.core.tween(560, easing = androidx.compose.animation.core.CubicBezierEasing(0.6f, -0.45f, 0.75f, 0.45f)), label = "tear")
    Column(
        modifier.fillMaxWidth()
            .layout { m, cons -> val pl = m.measure(cons); layout(pl.width, (pl.height * (1f - shrink)).roundToInt()) { pl.placeRelative(0, 0) } }
            .clipToBounds()
            .padding(start = 16.dp, end = 16.dp, top = 7.dp, bottom = 7.dp + (6 * shownFolds).dp).scale(squish),
    ) {
        Box {
            // Folds peeking out beneath: the same two-piece scooped shape, inset and dropped a little more each level.
            for (k in shownFolds - 1 downTo 0) {
                val inset = 8 * (k + 1)
                val fade = 0.12f * (k + 1)
                Row(
                    Modifier.matchParentSize().padding(horizontal = inset.dp).offset(y = (6 * (k + 1)).dp),
                    horizontalArrangement = Arrangement.spacedBy(gap),
                ) {
                    Box(
                        Modifier.weight(1f).fillMaxHeight().clip(bodyShape)
                            .background(androidx.compose.ui.graphics.lerp(c.card, c.ground, fade)).border(1.dp, c.line, bodyShape),
                    )
                    Box(
                        Modifier.width(stubW - inset.dp).fillMaxHeight().clip(stubShape)
                            .background(androidx.compose.ui.graphics.lerp(c.ground, tint, 0.16f - 0.03f * k)).border(1.dp, c.line, stubShape),
                    )
                }
            }
            Row(
                Modifier.fillMaxWidth().height(IntrinsicSize.Min)
                        .pointerInput(done, torn) {
                            if (done && !torn) detectHorizontalDragGestures(
                                onDragStart = { off ->
                                    grabBody = off.x < size.width - stubW.toPx()
                                    dragging = true
                                },
                                // The stub tracks the finger the whole way; letting go decides: far enough tears it,
                                // otherwise it springs back. (Either direction counts: the stub is near the screen edge.)
                                onDragEnd = {
                                    dragging = false
                                    if (kotlin.math.abs(dragPx) > 44.dp.toPx()) torn = true
                                    else scope.launch { androidx.compose.animation.core.animate(dragPx, 0f, animationSpec = androidx.compose.animation.core.spring(0.55f, 500f)) { v, _ -> dragPx = v } }
                                },
                                onDragCancel = {
                                    dragging = false
                                    scope.launch { androidx.compose.animation.core.animate(dragPx, 0f, animationSpec = androidx.compose.animation.core.spring(0.55f, 500f)) { v, _ -> dragPx = v } }
                                },
                            ) { change, amount ->
                                change.consume()
                                dragPx = (dragPx + amount).coerceIn(-160.dp.toPx(), 160.dp.toPx())
                            }
                        },
                horizontalArrangement = Arrangement.spacedBy(gap),
            ) {
                Row(
                    Modifier.weight(1f).fillMaxHeight()
                        // Pulled left while the stub is dragged right, then off screen the moment the stub is torn.
                        .graphicsLayer {
                            // Grabbed by the body: it follows the finger 1:1 and the stub eases away the other way.
                            translationX = -slide * (size.width + 48.dp.toPx()) + (1f - slide) * (if (grabBody) dragPx else -kotlin.math.abs(dragPx) * 0.12f)
                            rotationZ = -slide * 4f
                            val s = if (grabBody) 1f + 0.03f * lift else 1f
                            scaleX = s; scaleY = s
                        }
                        .shadow(3.dp, bodyShape).clip(bodyShape).background(c.card)
                        .clickable(interactionSource = source, indication = null, role = Role.Button) { done = !done; if (!done) { torn = false; dragPx = 0f } }
                        .padding(start = 14.dp, end = 16.dp, top = 14.dp, bottom = 14.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                ) {
                    // Hole-punch check (ring -> dark cookie); the stub is for information only.
                    PunchCheck(task.title, done, boxSize = 44.dp) { done = !done; if (!done) { torn = false; dragPx = 0f } }
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(8.dp)) {
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
                }
                // Stub slot keeps its width, so the body never expands once the stub is gone.
                Box(Modifier.width(stubW).fillMaxHeight()) {
                    Column(
                        Modifier
                            .requiredWidth(stubW).fillMaxHeight()
                            .graphicsLayer {
                                val stubDrag = if (grabBody) kotlin.math.abs(dragPx) * 0.12f else dragPx
                                translationX = tear * 520.dp.toPx() + stubDrag * (1f - tear)
                                translationY = tear * 40.dp.toPx()
                                rotationZ = tear * 22f + stubDrag * (1f - tear) * 0.04f
                                val s = if (!grabBody) 1f + 0.03f * lift else 1f
                                scaleX = s; scaleY = s
                                alpha = (1f - tear).coerceIn(0f, 1f)
                            }
                            .shadow(3.dp, stubShape).clip(stubShape).background(c.card).background(stubTint)
                            .clickable(enabled = done && !torn, role = Role.Button) { torn = true }
                            .padding(8.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterVertically),
                    ) {
                        Text(
                            (label?.text ?: "Any day").uppercase(), style = StubMono,
                            color = if (label?.urgent == true) c.urgentFg else if (label == null) c.muted else c.ink,
                            maxLines = 2, textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                        )
                        if (done && !torn) {
                            Text("TEAR ›", style = StubMono.copy(fontSize = 11.sp, fontWeight = FontWeight.Bold), color = c.ink)
                        } else if (facts.subtasks.isNotEmpty()) {
                            Text("$left folds", style = StubMono.copy(fontSize = 11.sp), color = c.muted)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun SoftTicketList() {
    val c = LocalColors.current
    val board = remember { Board(SampleData.workspace()) }
    var epoch by remember { mutableStateOf(0) }
    Column(Modifier.background(c.ground).padding(vertical = 12.dp)) {
        Text("YOUR STACK, SOFT", style = Type.section, color = c.muted, modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp))
        androidx.compose.runtime.key(epoch) { board.facts.take(5).forEachIndexed { i, f -> SoftTicketCard(f, i) } }
        Text("RESTORE TICKETS", style = Type.section, color = c.muted, modifier = Modifier.clickable { epoch++ }.padding(horizontal = 20.dp, vertical = 12.dp))
    }
}

@Preview(name = "Soft ticket list", widthDp = 380, showBackground = true)
@Composable
private fun SoftTicketListPreview() = AlongsideTheme(darkTheme = false, expressive = true) { SoftTicketList() }

@Preview(name = "Soft ticket list, dark", widthDp = 380, showBackground = true)
@Composable
private fun SoftTicketListDarkPreview() = AlongsideTheme(darkTheme = true, expressive = true) { SoftTicketList() }
