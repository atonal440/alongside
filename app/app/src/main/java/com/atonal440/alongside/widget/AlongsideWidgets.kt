package com.atonal440.alongside.widget

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.ColorFilter
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.action.ActionParameters
import androidx.glance.action.actionParametersOf
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.ActionCallback
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.appWidgetBackground
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.glance.appwidget.updateAll
import androidx.glance.background
import androidx.glance.color.ColorProvider
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.layout.width
import androidx.glance.semantics.contentDescription
import androidx.glance.semantics.semantics
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider as FixedColor
import com.atonal440.alongside.MainActivity
import com.atonal440.alongside.R
import com.atonal440.alongside.data.Repository
import com.atonal440.alongside.domain.Board
import com.atonal440.alongside.domain.Clock
import com.atonal440.alongside.domain.Order
import com.atonal440.alongside.domain.TaskFacts
import com.atonal440.alongside.domain.dateLabel
import com.atonal440.alongside.domain.projectColor
import com.atonal440.alongside.domain.recurrenceLabel
import java.time.temporal.ChronoUnit

object AlongsideWidgets {
    suspend fun updateAll(context: Context) {
        runCatching {
            ReadyWidget().updateAll(context)
            FocusWidget().updateAll(context)
            TodayWidget().updateAll(context)
        }
    }
}

/** Day/night pairs from the canvas: the light wide widget and the dark tall one. */
private object W {
    val bg = ColorProvider(Color(0xFFFBF9FF), Color(0xFF25213F))
    val ink = ColorProvider(Color(0xFF1F1B3A), Color(0xFFF3F0FF))
    val muted = ColorProvider(Color(0xFF5B5780), Color(0xFFB9B3DD))
    val badge = ColorProvider(Color(0xFFCFC5F5), Color(0xFF4A3F86))
    val urgentBg = ColorProvider(Color(0xFFFFD9C7), Color(0xFF5A2A2F))
    val urgentFg = ColorProvider(Color(0xFF8A2B0E), Color(0xFFFFD9D2))
    val softBg = ColorProvider(Color(0xFFE9E5F7), Color(0xFF332E57))
    val peach = FixedColor(Color(0xFFFF8A4C))
    val onPeach = FixedColor(Color(0xFF1F1B3A))
    val focusBg = ColorProvider(Color(0xFFCFC5F5), Color(0xFF3B3470))
    val focusButton = ColorProvider(Color(0xFF1F1B3A), Color(0xFFBDEB6B))
    val focusButtonFg = ColorProvider(Color(0xFFFFFFFF), Color(0xFF1F1B3A))
    val lime = FixedColor(Color(0xFFC9EE8A))
    val darkInk = FixedColor(Color(0xFF1F1B3A))
}

val TaskIdKey = ActionParameters.Key<String>("taskId")

/** Completes a task straight from the home screen. */
class CompleteTaskAction : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        val id = parameters[TaskIdKey] ?: return
        val repo = Repository.get(context)
        repo.complete(id)
        // The process may be reclaimed once this returns, so send it now rather than in the background.
        repo.refresh()
    }
}

private fun openApp(context: Context, taskId: String? = null, newTask: Boolean = false) =
    actionStartActivity(
        Intent(context, MainActivity::class.java)
            .setFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .apply {
                if (newTask) putExtra(MainActivity.EXTRA_NEW_TASK, true)
                if (taskId != null) {
                    putExtra(MainActivity.EXTRA_TASK_ID, taskId)
                    // Distinct data so each row's PendingIntent isn't collapsed into one.
                    data = android.net.Uri.parse("alongside://task/$taskId")
                }
                if (newTask) data = android.net.Uri.parse("alongside://new")
            },
    )

private fun style(size: TextUnit, color: androidx.glance.unit.ColorProvider, bold: Boolean = false) =
    TextStyle(color = color, fontSize = size, fontWeight = if (bold) FontWeight.Bold else FontWeight.Medium)

@Composable
private fun Pebble(facts: TaskFacts, size: Dp = 24.dp) {
    Box(
        GlanceModifier.size(44.dp)
            .clickable(actionRunCallback<CompleteTaskAction>(actionParametersOf(TaskIdKey to facts.task.id)))
            .semantics { contentDescription = "Complete ${facts.task.title}" },
        contentAlignment = Alignment.Center,
    ) {
        Image(ImageProvider(R.drawable.ic_widget_pebble), null, GlanceModifier.size(size), colorFilter = ColorFilter.tint(W.ink))
    }
}

@Composable
private fun Tag(text: String, bg: androidx.glance.unit.ColorProvider, fg: androidx.glance.unit.ColorProvider) {
    Text(
        text, style = style(12.sp, fg, bold = true), maxLines = 1,
        modifier = GlanceModifier.background(bg).cornerRadius(8.dp).padding(horizontal = 8.dp, vertical = 4.dp),
    )
}

/**
 * Widgets render from the cache straight away and, when it's stale, pull from the worker in the
 * background; the pull's publish then redraws them. The age check keeps the redraw that follows
 * a pull from triggering another one.
 */
private suspend fun loadedRepo(context: Context) = Repository.get(context).also {
    it.ensureLoaded()
    it.refreshIfStale(maxAgeMillis = 15 * 60 * 1000L)
}

// ---------------------------------------------------------------------------------------------
// Ready now: 4x2 shows the top three; taller sizes split into Today / This week with a footer.

class ReadyWidget : GlanceAppWidget() {
    override val sizeMode = SizeMode.Exact

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val repo = loadedRepo(context)
        provideContent {
            val ws by repo.workspace.collectAsState()
            ReadyContent(Board(ws))
        }
    }
}

class ReadyWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = ReadyWidget()
}

@Composable
private fun ReadyContent(board: Board) {
    val context = LocalContext.current
    val size = LocalSize.current
    val tall = size.height >= 240.dp
    val ready = board.facts.filter { it.isReady }.sortedWith(Board.comparator(Order.Soonest, false))
    val rowHeight = if (tall) 56.dp else 44.dp
    val footer = if (tall) 68.dp else 0.dp
    val capacity = ((size.height - 60.dp - footer - (if (tall) 40.dp else 0.dp)) / rowHeight).toInt().coerceAtLeast(1)

    Column(
        GlanceModifier.fillMaxSize().appWidgetBackground().background(W.bg).cornerRadius(28.dp),
    ) {
        Row(
            GlanceModifier.fillMaxWidth().height(56.dp).padding(start = 18.dp, end = 8.dp, top = 8.dp)
                .clickable(openApp(context)),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(if (tall) "Alongside" else "Ready now", style = style(20.sp, W.ink, bold = true))
            Spacer(GlanceModifier.width(8.dp))
            Text("${ready.size}", style = style(12.sp, W.ink, bold = true), modifier = GlanceModifier.background(W.badge).cornerRadius(8.dp).padding(horizontal = 8.dp, vertical = 4.dp))
            Spacer(GlanceModifier.defaultWeight())
            if (!tall) AddButton(context, compact = true)
        }

        if (ready.isEmpty()) {
            Text(
                "Nothing ready. Enjoy it.", style = style(14.sp, W.muted),
                modifier = GlanceModifier.padding(horizontal = 18.dp, vertical = 12.dp),
            )
        } else if (!tall) {
            ready.take(capacity).forEach { CompactRow(it, context) }
        } else {
            val today = Clock.today()
            val (now, later) = ready.partition { f ->
                f.isFocused || f.isOverdue || f.targetDay?.let { !it.isAfter(today) } == true ||
                    f.deadlinePoint?.let { ChronoUnit.DAYS.between(today, f.deadline!!.atZone(Clock.zone).toLocalDate()) <= 1 } == true
            }
            var room = capacity
            Column(GlanceModifier.defaultWeight().fillMaxWidth()) {
                if (now.isNotEmpty()) {
                    Section("Today")
                    now.take(room).forEach { TallRow(it, board, context) }
                    room -= now.size.coerceAtMost(room)
                }
                if (later.isNotEmpty() && room > 0) {
                    Section(if (now.isEmpty()) "Ready" else "Up next")
                    later.take(room).forEach { TallRow(it, board, context) }
                }
            }
            val hidden = (ready.size - capacity).coerceAtLeast(0) + board.counts.napping + board.counts.waiting
            Row(
                GlanceModifier.fillMaxWidth().padding(start = 18.dp, end = 12.dp, top = 6.dp, bottom = 14.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    if (hidden > 0) "$hidden more napping, waiting or later" else "That's everything",
                    style = style(13.sp, W.muted, bold = true), modifier = GlanceModifier.defaultWeight(), maxLines = 1,
                )
                AddButton(context, compact = false)
            }
        }
    }
}

@Composable
private fun Section(text: String) {
    Text(
        text.uppercase(), style = style(11.5.sp, W.muted, bold = true),
        modifier = GlanceModifier.padding(start = 18.dp, top = 8.dp, bottom = 2.dp),
    )
}

@Composable
private fun AddButton(context: Context, compact: Boolean) {
    if (compact) {
        Box(
            GlanceModifier.size(44.dp).background(W.peach).cornerRadius(16.dp).clickable(openApp(context, newTask = true))
                .semantics { contentDescription = "New task" },
            contentAlignment = Alignment.Center,
        ) { Image(ImageProvider(R.drawable.ic_widget_plus), null, GlanceModifier.size(22.dp), colorFilter = ColorFilter.tint(W.onPeach)) }
    } else {
        Row(
            GlanceModifier.height(48.dp).background(W.peach).cornerRadius(16.dp).padding(start = 14.dp, end = 20.dp)
                .clickable(openApp(context, newTask = true)),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Image(ImageProvider(R.drawable.ic_widget_plus), null, GlanceModifier.size(20.dp), colorFilter = ColorFilter.tint(W.onPeach))
            Spacer(GlanceModifier.width(6.dp))
            Text("Add", style = style(15.sp, W.onPeach, bold = true))
        }
    }
}

@Composable
private fun CompactRow(f: TaskFacts, context: Context) {
    Row(
        GlanceModifier.fillMaxWidth().height(44.dp).padding(start = 4.dp, end = 16.dp).clickable(openApp(context, taskId = f.task.id)),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Pebble(f)
        Text(f.task.title, style = style(15.sp, W.ink, bold = false), maxLines = 1, modifier = GlanceModifier.defaultWeight())
        val label = f.dateLabel(short = true)
        when {
            label != null -> Box(GlanceModifier.padding(start = 8.dp)) { if (label.urgent) Tag(label.text, W.urgentBg, W.urgentFg) else Tag(label.text, W.softBg, W.muted) }
            recurrenceLabel(f.task) != null -> Box(GlanceModifier.padding(start = 8.dp)) { Tag(recurrenceLabel(f.task)!!, W.softBg, W.muted) }
        }
    }
}

@Composable
private fun TallRow(f: TaskFacts, board: Board, context: Context) {
    Row(
        GlanceModifier.fillMaxWidth().height(56.dp).padding(start = 4.dp, end = 16.dp).clickable(openApp(context, taskId = f.task.id)),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Pebble(f)
        Column(GlanceModifier.defaultWeight()) {
            Text(f.task.title, style = style(15.sp, W.ink, bold = true), maxLines = 1)
            Row(GlanceModifier.padding(top = 3.dp), verticalAlignment = Alignment.CenterVertically) {
                f.dateLabel(short = true)?.let { label ->
                    if (label.urgent) Tag(label.text, W.urgentBg, W.urgentFg) else Text(label.text, style = style(12.5.sp, W.muted))
                    Spacer(GlanceModifier.width(8.dp))
                }
                val project = board.ws.project(f.task.project_id)
                if (project != null) {
                    Box(GlanceModifier.size(8.dp).background(FixedColor(Color(projectColor(project.id)))).cornerRadius(4.dp)) {}
                    Spacer(GlanceModifier.width(5.dp))
                }
                val extra = buildList {
                    add(project?.title ?: "Inbox")
                    recurrenceLabel(f.task)?.let(::add)
                    if (f.subtasks.isNotEmpty()) add("${f.subtasksDone}/${f.subtasks.size}")
                }
                Text(extra.joinToString(" · "), style = style(12.5.sp, W.muted), maxLines = 1)
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Focus: one task, big, with a check.

class FocusWidget : GlanceAppWidget() {
    override val sizeMode = SizeMode.Single

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val repo = loadedRepo(context)
        provideContent {
            val ws by repo.workspace.collectAsState()
            FocusContent(Board(ws))
        }
    }
}

class FocusWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = FocusWidget()
}

@Composable
private fun FocusContent(board: Board) {
    val context = LocalContext.current
    val f = board.headline()
    Column(
        GlanceModifier.fillMaxSize().appWidgetBackground().background(W.focusBg).cornerRadius(28.dp).padding(14.dp)
            .clickable(openApp(context, taskId = f?.task?.id)),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Image(ImageProvider(R.drawable.ic_widget_star), null, GlanceModifier.size(14.dp), colorFilter = ColorFilter.tint(W.ink))
            Spacer(GlanceModifier.width(5.dp))
            Text(if (f?.isFocused == true) "FOCUS" else "UP NEXT", style = style(12.sp, W.ink, bold = true))
        }
        Spacer(GlanceModifier.height(8.dp))
        Text(f?.task?.title ?: "Nothing to focus on", style = style(19.sp, W.ink, bold = true), maxLines = 3)
        Spacer(GlanceModifier.defaultWeight())
        if (f != null) {
            Row(GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Text(f.dateLabel()?.text ?: board.ws.project(f.task.project_id)?.title ?: "Inbox", style = style(12.sp, W.ink, bold = true), maxLines = 1, modifier = GlanceModifier.defaultWeight())
                Box(
                    GlanceModifier.size(44.dp).background(W.focusButton).cornerRadius(22.dp)
                        .clickable(actionRunCallback<CompleteTaskAction>(actionParametersOf(TaskIdKey to f.task.id)))
                        .semantics { contentDescription = "Complete ${f.task.title}" },
                    contentAlignment = Alignment.Center,
                ) { Image(ImageProvider(R.drawable.ic_widget_check), null, GlanceModifier.size(22.dp), colorFilter = ColorFilter.tint(W.focusButtonFg)) }
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Today: a ring of what's done against what's left.

class TodayWidget : GlanceAppWidget() {
    override val sizeMode = SizeMode.Single

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val repo = loadedRepo(context)
        provideContent {
            val ws by repo.workspace.collectAsState()
            TodayContent(Board(ws))
        }
    }
}

class TodayWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = TodayWidget()
}

@Composable
private fun TodayContent(board: Board) {
    val context = LocalContext.current
    val (done, left) = board.todayProgress()
    val description = if (left == 0) "All clear today, $done done" else "$done done, $left left today"
    Column(
        GlanceModifier.fillMaxSize().appWidgetBackground().background(W.lime).cornerRadius(28.dp).padding(14.dp).clickable(openApp(context)),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("TODAY", style = style(12.sp, W.darkInk, bold = true), modifier = GlanceModifier.fillMaxWidth())
        Spacer(GlanceModifier.height(6.dp))
        Image(
            ImageProvider(ringBitmap(context, done, left)), description,
            GlanceModifier.size(104.dp),
        )
    }
}

/** Glance can't draw arcs, so the ring is painted once per update into a bitmap. */
private fun ringBitmap(context: Context, done: Int, left: Int): Bitmap {
    val density = context.resources.displayMetrics.density
    val px = (104 * density).toInt()
    val bitmap = Bitmap.createBitmap(px, px, Bitmap.Config.ARGB_8888)
    val canvas = Canvas(bitmap)
    val stroke = 12 * density
    val inset = 10 * density
    val rect = RectF(inset, inset, px - inset, px - inset)
    val ink = 0xFF1F1B3A.toInt()
    val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE; strokeWidth = stroke; strokeCap = Paint.Cap.ROUND }
    paint.color = 0x99FFFFFF.toInt()
    canvas.drawArc(rect, 0f, 360f, false, paint)
    val total = done + left
    if (total > 0 && done > 0) {
        paint.color = ink
        canvas.drawArc(rect, -90f, 360f * done / total, false, paint)
    }
    val text = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = ink; textAlign = Paint.Align.CENTER; typeface = Typeface.DEFAULT_BOLD }
    if (left == 0) {
        text.textSize = 18 * density
        canvas.drawText("All", px / 2f, px / 2f - 2 * density, text)
        canvas.drawText("clear", px / 2f, px / 2f + 18 * density, text)
    } else {
        text.textSize = 28 * density
        canvas.drawText("$left", px / 2f, px / 2f + 6 * density, text)
        text.textSize = 12 * density
        canvas.drawText("left", px / 2f, px / 2f + 23 * density, text)
    }
    return bitmap
}
