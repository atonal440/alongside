package com.atonal440.alongside.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.atonal440.alongside.data.SyncStatus
import com.atonal440.alongside.domain.Board
import com.atonal440.alongside.domain.Clock
import com.atonal440.alongside.domain.Filters
import com.atonal440.alongside.domain.Show
import com.atonal440.alongside.domain.TaskFacts
import com.atonal440.alongside.domain.greeting
import com.atonal440.alongside.domain.longDate
import com.atonal440.alongside.domain.summary
import com.atonal440.alongside.domain.weekdayLong
import com.atonal440.alongside.ui.components.AlongsideMark
import com.atonal440.alongside.ui.components.AppIcons
import com.atonal440.alongside.ui.components.FilterChip
import com.atonal440.alongside.ui.components.FoldRow
import com.atonal440.alongside.ui.components.IconBtn
import com.atonal440.alongside.ui.components.SectionLabel
import com.atonal440.alongside.ui.components.TaskRow
import com.atonal440.alongside.ui.theme.LocalColors
import com.atonal440.alongside.ui.theme.Type

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ListScreen(
    board: Board,
    filters: Filters,
    name: String,
    sync: SyncStatus,
    onRefresh: () -> Unit,
    onQuickView: (Show) -> Unit,
    onSearch: (String) -> Unit,
    onOpenFilters: () -> Unit,
    onOpenTask: (String) -> Unit,
    onComplete: (String) -> Unit,
    onOpenSettings: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val c = LocalColors.current
    val visible = remember(board, filters) { board.filtered(filters) }
    val projectTitle = { id: String? -> board.ws.project(id)?.title }

    PullToRefreshBox(isRefreshing = sync == SyncStatus.Syncing, onRefresh = onRefresh, modifier = modifier.fillMaxSize()) {
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 112.dp)) {
            item { Header(board, name, sync, onOpenSettings, onRefresh) }
            item { SearchBar(filters, board.counts.pending, onSearch, onOpenFilters) }
            item { QuickChips(board, filters, onQuickView) }

            if (filters.isPlainReady) {
                val focus = visible.filter { it.isFocused }
                val rest = visible.filterNot { it.isFocused }
                if (focus.isNotEmpty()) {
                    item { SectionLabel("Focus", icon = AppIcons.Star) }
                    items(focus, key = { it.task.id }) { TaskItem(it, projectTitle, onOpenTask, onComplete) }
                }
                item { SectionLabel("Ready now") }
                if (rest.isEmpty()) item { EmptyNote(if (focus.isEmpty()) "Nothing's ready. Enjoy it." else "Just the focus for now.") }
                items(rest, key = { it.task.id }) { TaskItem(it, projectTitle, onOpenTask, onComplete) }

                val napping = board.facts.filter { it.isNapping }
                if (napping.isNotEmpty()) item {
                    Spacer(Modifier.height(6.dp))
                    FoldRow(AppIcons.Moon, nappingLabel(napping), napping.size, onClick = { onQuickView(Show.Napping) })
                }
                if (board.counts.waiting > 0) item {
                    Spacer(Modifier.height(8.dp))
                    FoldRow(AppIcons.Lock, "Waiting on something", board.counts.waiting, onClick = { onQuickView(Show.Waiting) })
                }
            } else {
                item { SectionLabel(filters.show.sortedBy { it.ordinal }.joinToString(" · ") { if (it == Show.Ready) "Ready now" else it.label }) }
                if (visible.isEmpty()) item { EmptyNote("Nothing matches. Try loosening the filters.") }
                items(visible, key = { it.task.id }) { TaskItem(it, projectTitle, onOpenTask, onComplete) }
            }
        }
    }
}

@Composable
private fun TaskItem(facts: TaskFacts, projectTitle: (String?) -> String?, onOpen: (String) -> Unit, onComplete: (String) -> Unit) {
    TaskRow(facts, projectTitle(facts.task.project_id), onOpen = { onOpen(facts.task.id) }, onComplete = { onComplete(facts.task.id) })
}

private fun nappingLabel(napping: List<TaskFacts>): String {
    val days = napping.mapNotNull { it.deferUntil?.atZone(Clock.zone)?.toLocalDate() }.distinct().sorted()
    val first = days.firstOrNull() ?: return "Napping"
    val day = if (first == Clock.today().plusDays(1)) "tomorrow" else weekdayLong(first)
    return if (days.size == 1) "Napping until $day" else "Napping, first back $day"
}

@Composable
private fun Header(board: Board, name: String, sync: SyncStatus, onOpenSettings: () -> Unit, onRefresh: () -> Unit) {
    val c = LocalColors.current
    var menu by remember { mutableStateOf(false) }
    Column {
        Row(Modifier.padding(start = 20.dp, end = 8.dp, top = 20.dp), verticalAlignment = Alignment.CenterVertically) {
            AlongsideMark(Modifier.size(48.dp).semantics { contentDescription = "Alongside" })
            Spacer(Modifier.size(12.dp))
            Column(Modifier.weight(1f)) {
                Text(longDate(Clock.today()), style = Type.label.copy(fontSize = Type.meta.fontSize * 13 / 12.5), color = c.muted)
                Spacer(Modifier.height(2.dp))
                Text(greeting(name), style = Type.display, color = c.ink)
            }
            Box {
                IconBtn(AppIcons.More, "More", onClick = { menu = true })
                DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                    DropdownMenuItem(text = { Text("Sync now") }, leadingIcon = { Icon(AppIcons.Sync, null, Modifier.size(18.dp)) }, onClick = { menu = false; onRefresh() })
                    DropdownMenuItem(text = { Text("Settings") }, leadingIcon = { Icon(AppIcons.Filters, null, Modifier.size(18.dp)) }, onClick = { menu = false; onOpenSettings() })
                }
            }
        }
        val status = when (sync) {
            is SyncStatus.Failed -> sync.message
            else -> board.counts.summary()
        }
        Text(
            status, style = Type.body.copy(fontSize = Type.label.fontSize, lineHeight = Type.meta.lineHeight * 1.2f),
            color = if (sync is SyncStatus.Failed) c.urgentFg else c.muted,
            modifier = Modifier.padding(start = 20.dp, end = 20.dp, top = 8.dp),
        )
    }
}

@Composable
private fun SearchBar(filters: Filters, total: Int, onSearch: (String) -> Unit, onOpenFilters: () -> Unit) {
    val c = LocalColors.current
    Row(
        Modifier
            .padding(start = 16.dp, end = 16.dp, top = 14.dp)
            .fillMaxWidth()
            .height(52.dp)
            .clip(RoundedCornerShape(18.dp))
            .background(c.soft)
            .padding(start = 16.dp, end = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Icon(AppIcons.Search, null, Modifier.size(18.dp), tint = c.ink)
        Box(Modifier.weight(1f)) {
            if (filters.query.isEmpty()) Text("Search $total tasks", style = Type.body, color = c.muted)
            BasicTextField(
                value = filters.query, onValueChange = onSearch, singleLine = true,
                textStyle = Type.body.copy(color = c.ink), cursorBrush = SolidColor(c.ink),
                modifier = Modifier.fillMaxWidth().semantics { contentDescription = "Search tasks" },
            )
        }
        if (filters.query.isNotEmpty()) IconBtn(AppIcons.Close, "Clear search", onClick = { onSearch("") }, size = 18.dp)
        val active = filters.refinementCount
        Box {
            IconBtn(AppIcons.Filters, if (active > 0) "Filters, $active active" else "Filters", onClick = onOpenFilters, size = 22.dp)
            if (active > 0) {
                Text(
                    "$active", style = Type.tag.copy(fontSize = Type.tag.fontSize * 11 / 12), color = c.onPeach, textAlign = TextAlign.Center,
                    modifier = Modifier.align(Alignment.TopEnd).offset((-2).dp, 6.dp).sizeIn(minWidth = 18.dp)
                        .clip(RoundedCornerShape(9.dp)).background(c.peach).padding(horizontal = 4.dp, vertical = 2.dp),
                )
            }
        }
    }
}

@Composable
private fun QuickChips(board: Board, filters: Filters, onQuickView: (Show) -> Unit) {
    Row(
        Modifier.horizontalScroll(rememberScrollState()).padding(start = 16.dp, end = 16.dp, top = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Show.entries.filter { it.chip }.forEach { show ->
            FilterChip(show.label, selected = filters.show == setOf(show), onClick = { onQuickView(show) }, count = board.counts.of(show))
        }
    }
}

@Composable
fun EmptyNote(text: String) {
    Text(text, style = Type.body, color = LocalColors.current.muted, modifier = Modifier.padding(horizontal = 20.dp, vertical = 16.dp))
}
