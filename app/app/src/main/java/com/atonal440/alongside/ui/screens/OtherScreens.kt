package com.atonal440.alongside.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.ui.unit.dp
import com.atonal440.alongside.data.Duty
import com.atonal440.alongside.data.Settings
import com.atonal440.alongside.data.sync.RetainedOp
import com.atonal440.alongside.domain.Board
import com.atonal440.alongside.domain.Clock
import com.atonal440.alongside.domain.INBOX
import com.atonal440.alongside.domain.TaskFacts
import com.atonal440.alongside.domain.friendlyDay
import com.atonal440.alongside.domain.liveSeries
import com.atonal440.alongside.domain.nextOccurrenceLabel
import com.atonal440.alongside.domain.recurrenceLabel
import com.atonal440.alongside.ui.components.AlongsideMark
import com.atonal440.alongside.ui.components.AppIcons
import com.atonal440.alongside.ui.components.IconBtn
import com.atonal440.alongside.ui.components.OutlineButton
import com.atonal440.alongside.ui.components.PrimaryButton
import com.atonal440.alongside.ui.components.ProjectDot
import com.atonal440.alongside.ui.components.ProjectMeta
import com.atonal440.alongside.ui.theme.LocalColors
import com.atonal440.alongside.ui.theme.Type
import java.text.DateFormat
import java.util.Date

@Composable
private fun ScreenTitle(title: String, subtitle: String) {
    val c = LocalColors.current
    Column(Modifier.padding(start = 20.dp, end = 20.dp, top = 24.dp, bottom = 8.dp)) {
        Text(title, style = Type.display, color = c.ink)
        Text(subtitle, style = Type.body.copy(fontSize = Type.label.fontSize), color = c.muted, modifier = Modifier.padding(top = 6.dp))
    }
}

/** Projects with their live counts; tapping one narrows the task list to it. */
@Composable
fun ProjectsScreen(board: Board, onOpenProject: (String) -> Unit, modifier: Modifier = Modifier) {
    val c = LocalColors.current
    val active = board.ws.projects.filter { it.isActive }.sortedBy { it.title.lowercase() }
    val pending = board.facts.filterNot { it.isDone }
    LazyColumn(modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
        item { ScreenTitle("Projects", "${active.size} active. Tap one to see its tasks.") }
        items(active, key = { it.id }) { p ->
            val mine = pending.filter { it.task.project_id == p.id }
            ProjectRow(p.id, p.title, mine.count { it.isReady }, mine.size) { onOpenProject(p.id) }
        }
        item {
            val inbox = pending.filter { it.task.project_id == null || board.ws.project(it.task.project_id) == null }
            ProjectRow(null, "Inbox", inbox.count { it.isReady }, inbox.size) { onOpenProject(INBOX) }
        }
        val archived = board.ws.projects.count { !it.isActive }
        if (archived > 0) item {
            Text("$archived archived", style = Type.meta, color = c.muted, modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp))
        }
    }
}

@Composable
private fun ProjectRow(id: String?, title: String, ready: Int, open: Int, onClick: () -> Unit) {
    val c = LocalColors.current
    Row(
        Modifier.padding(horizontal = 16.dp, vertical = 4.dp).fillMaxWidth().heightIn(min = 64.dp)
            .clip(RoundedCornerShape(18.dp)).background(c.card).clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        if (id != null) ProjectDot(id, 12.dp) else Icon(AppIcons.Tasks, null, Modifier.size(16.dp), tint = c.muted)
        Column(Modifier.weight(1f)) {
            Text(title, style = Type.rowTitle, color = c.ink)
            Text("$ready ready · $open open", style = Type.meta, color = c.muted)
        }
        Icon(AppIcons.ChevronRight, null, Modifier.size(18.dp), tint = c.muted)
    }
}

/**
 * Repeating work. A series (duty) is listed once, whether or not it has made a task yet: the worker makes each occurrence
 * only when it is due, so the list is the only place an upcoming one shows. Older repeating tasks that are not in a series follow.
 */
@Composable
fun RoutinesScreen(board: Board, onOpenTask: (String) -> Unit, onOpenSeries: (String) -> Unit, modifier: Modifier = Modifier) {
    val series = liveSeries(board.ws.duties)
    val legacy = board.facts.filter { it.isRepeating && it.task.duty_id == null && !it.isDone }.sortedWith(compareBy(nullsLast()) { it.soonest })
    LazyColumn(modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
        item { ScreenTitle("Routines", "Things that come back around.") }
        if (series.isEmpty() && legacy.isEmpty()) item { EmptyNote("No repeating tasks yet.") }
        items(series, key = { "series:" + it.id }) { d -> SeriesRow(d, board.ws.project(d.project_id)?.title) { onOpenSeries(d.id) } }
        items(legacy, key = { it.task.id }) { f -> RoutineRow(f, board.ws.project(f.task.project_id)?.title) { onOpenTask(f.task.id) } }
    }
}

@Composable
private fun SeriesRow(duty: Duty, projectTitle: String?, onClick: () -> Unit) {
    val c = LocalColors.current
    Row(
        Modifier.padding(horizontal = 16.dp, vertical = 4.dp).fillMaxWidth().heightIn(min = 68.dp)
            .clip(RoundedCornerShape(18.dp)).background(c.card).clickable(role = Role.Button, onClick = onClick).padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Icon(AppIcons.Repeat, null, Modifier.size(20.dp), tint = c.ink)
        Column(Modifier.weight(1f)) {
            Text(duty.title, style = Type.rowTitle, color = c.ink)
            Row(Modifier.padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(recurrenceLabel(duty.rrule) ?: "Repeats", style = Type.meta, color = c.muted)
                if (duty.isPaused) Text("Paused", style = Type.meta, color = c.muted)
                else nextOccurrenceLabel(duty)?.let { Text("Next $it", style = Type.meta, color = c.muted) }
                ProjectMeta(duty.project_id, projectTitle)
            }
        }
    }
}

@Composable
private fun RoutineRow(f: TaskFacts, projectTitle: String?, onClick: () -> Unit) {
    val c = LocalColors.current
    Row(
        Modifier.padding(horizontal = 16.dp, vertical = 4.dp).fillMaxWidth().heightIn(min = 68.dp)
            .clip(RoundedCornerShape(18.dp)).background(c.card).clickable(onClick = onClick).padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        Icon(AppIcons.Repeat, null, Modifier.size(20.dp), tint = c.ink)
        Column(Modifier.weight(1f)) {
            Text(f.task.title, style = Type.rowTitle, color = c.ink)
            Row(Modifier.padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(recurrenceLabel(f.task) ?: "Repeats", style = Type.meta, color = c.muted)
                f.soonest?.let { Text("Next ${friendlyDay(it.atZone(Clock.zone).toLocalDate(), withDayNumber = true)}", style = Type.meta, color = c.muted) }
                ProjectMeta(f.task.project_id, projectTitle)
            }
        }
    }
}

/** Connection settings. Also the first screen on a fresh install. */
@Composable
fun SettingsScreen(
    current: Settings,
    syncedAtMillis: Long?,
    firstRun: Boolean,
    onSave: (Settings) -> Unit,
    onClose: () -> Unit,
    needsAttention: List<RetainedOp> = emptyList(),
    onRetryNeedsAttention: () -> Unit = {},
    onDiscardNeedsAttention: () -> Unit = {},
) {
    val c = LocalColors.current
    var url by remember { mutableStateOf(current.serverUrl.ifBlank { "http://10.0.2.2:8787" }) }
    var token by remember { mutableStateOf(current.token) }
    var name by remember { mutableStateOf(current.name) }
    val normalizedUrl = remember(url) { Settings.normalizeServerUrl(url) }

    Column(Modifier.fillMaxSize().background(c.ground).statusBarsPadding().navigationBarsPadding().imePadding()) {
        if (!firstRun) IconBtn(AppIcons.Back, "Back", onClose, Modifier.padding(start = 8.dp, top = 12.dp))
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 20.dp)) {
            if (firstRun) {
                Spacer(Modifier.height(48.dp))
                AlongsideMark(Modifier.size(72.dp))
                Spacer(Modifier.height(20.dp))
                Text("Hello. Let's find your tasks.", style = Type.title, color = c.ink)
                Text(
                    "Point Alongside at your worker and paste its access token. Everything stays on this phone and your server.",
                    style = Type.body, color = c.muted, modifier = Modifier.padding(top = 10.dp),
                )
            } else {
                Text("Settings", style = Type.title, color = c.ink, modifier = Modifier.padding(top = 4.dp))
                val status = when {
                    current.sampleMode -> "Showing sample data. Nothing is sent anywhere."
                    syncedAtMillis != null -> "Last synced ${DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(syncedAtMillis))}."
                    else -> "Not synced yet."
                }
                Text(status, style = Type.body, color = c.muted, modifier = Modifier.padding(top = 8.dp))
                if (needsAttention.isNotEmpty()) NeedsAttentionCard(needsAttention, onRetryNeedsAttention, onDiscardNeedsAttention)
            }
            Spacer(Modifier.height(24.dp))
            SettingField("Server", url, { url = it }, "https://alongside.example.workers.dev", KeyboardType.Uri)
            if (url.isNotBlank() && normalizedUrl == null) {
                Text(
                    "That doesn't look like a web address. Try https://your-worker.workers.dev",
                    style = Type.meta, color = c.urgentFg, modifier = Modifier.padding(bottom = 18.dp),
                )
            }
            SettingField("Access token", token, { token = it }, "Your AUTH_TOKEN", KeyboardType.Password, secret = true)
            SettingField("What should I call you?", name, { name = it }, "Optional", KeyboardType.Text)
            Text(
                "On the emulator, 10.0.2.2 reaches a worker running on your computer.",
                style = Type.meta, color = c.muted, modifier = Modifier.padding(top = 4.dp),
            )
        }
        Column(Modifier.padding(start = 20.dp, end = 20.dp, top = 12.dp, bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            PrimaryButton(
                "Connect and sync",
                enabled = normalizedUrl != null && token.isNotBlank(),
                onClick = { normalizedUrl?.let { onSave(Settings(it, token, name, sampleMode = false)) } },
                modifier = Modifier.fillMaxWidth(),
            )
            if (!current.sampleMode) {
                OutlineButton("Look around with sample data", onClick = { onSave(Settings(normalizedUrl ?: "", token, name, sampleMode = true)) }, modifier = Modifier.fillMaxWidth())
            } else if (!firstRun) {
                OutlineButton("Keep using sample data", onClick = { onSave(current.copy(name = name)) }, modifier = Modifier.fillMaxWidth())
            }
        }
    }
}

/** Changes the server refused, kept so the person's intent isn't lost: try them again as new changes, or discard. */
@Composable
private fun NeedsAttentionCard(ops: List<RetainedOp>, onRetry: () -> Unit, onDiscard: () -> Unit) {
    val c = LocalColors.current
    val count = ops.size
    Column(
        Modifier.padding(top = 16.dp).fillMaxWidth().clip(RoundedCornerShape(20.dp)).background(c.urgentBg).padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(
            if (count == 1) "1 change needs attention" else "$count changes need attention",
            style = Type.rowTitle, color = c.urgentFg,
        )
        ops.take(3).forEach { r ->
            Text("${r.op.intent.describe()}: ${r.reason.message}", style = Type.body, color = c.urgentFg)
        }
        if (count > 3) Text("and ${count - 3} more", style = Type.meta, color = c.urgentFg)
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            PrimaryButton("Try again", onClick = onRetry, modifier = Modifier.weight(1f))
            OutlineButton("Discard", onClick = onDiscard)
        }
    }
}

@Composable
private fun SettingField(label: String, value: String, onChange: (String) -> Unit, placeholder: String, type: KeyboardType, secret: Boolean = false) {
    val c = LocalColors.current
    Text(label.uppercase(), style = Type.section, color = c.muted, modifier = Modifier.padding(bottom = 8.dp))
    Row(
        Modifier.padding(bottom = 18.dp).fillMaxWidth().heightIn(min = 52.dp).clip(RoundedCornerShape(16.dp)).background(c.soft).padding(horizontal = 16.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            if (value.isEmpty()) Text(placeholder, style = Type.body, color = c.muted)
            BasicTextField(
                value, onChange, singleLine = true,
                textStyle = Type.body.copy(color = c.ink), cursorBrush = SolidColor(c.ink),
                keyboardOptions = KeyboardOptions(keyboardType = type, autoCorrectEnabled = false),
                visualTransformation = if (secret) PasswordVisualTransformation() else VisualTransformation.None,
                modifier = Modifier.fillMaxWidth().semantics { contentDescription = label },
            )
        }
    }
}
