package com.atonal440.alongside.ui

import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.atonal440.alongside.domain.NapChoice
import com.atonal440.alongside.ui.components.AppIcons
import com.atonal440.alongside.ui.screens.DetailScreen
import com.atonal440.alongside.ui.screens.FiltersSheet
import com.atonal440.alongside.ui.screens.ListScreen
import com.atonal440.alongside.ui.screens.NapSheet
import com.atonal440.alongside.ui.screens.QuickAddSheet
import com.atonal440.alongside.ui.screens.ProjectsScreen
import com.atonal440.alongside.ui.screens.RoutinesScreen
import com.atonal440.alongside.ui.screens.SettingsScreen
import com.atonal440.alongside.ui.theme.LocalColors
import com.atonal440.alongside.ui.theme.Type
import kotlinx.coroutines.launch

@Composable
fun AlongsideApp(vm: AppViewModel) {
    val c = LocalColors.current
    val settings by vm.settings.collectAsStateWithLifecycle()
    val board by vm.board.collectAsStateWithLifecycle()
    val filters by vm.filters.collectAsStateWithLifecycle()
    val tab by vm.tab.collectAsStateWithLifecycle()
    val detail by vm.detail.collectAsStateWithLifecycle()
    val showSettings by vm.showSettings.collectAsStateWithLifecycle()
    val sync by vm.sync.collectAsStateWithLifecycle()
    val newTaskRequested by vm.newTaskRequested.collectAsState()
    val needsAttention by vm.needsAttention.collectAsStateWithLifecycle()

    var filtersOpen by remember { mutableStateOf(false) }
    var newTaskOpen by remember { mutableStateOf(false) }
    var napFor by remember { mutableStateOf<String?>(null) }
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()

    LaunchedEffect(newTaskRequested) {
        if (newTaskRequested) { newTaskOpen = true; vm.newTaskRequested.value = false }
    }
    LaunchedEffect(Unit) {
        vm.undo.collect { item ->
            scope.launch {
                snackbar.currentSnackbarData?.dismiss()
                val result = snackbar.showSnackbar("Done: ${item.title}", actionLabel = "Undo", duration = SnackbarDuration.Short)
                if (result == SnackbarResult.ActionPerformed) vm.undoComplete(item)
            }
        }
    }
    LaunchedEffect(Unit) {
        vm.messages.collect { message -> scope.launch { snackbar.showSnackbar(message) } }
    }

    BackHandler(enabled = detail.isNotEmpty() || showSettings || tab != Tab.Tasks) { vm.back() }

    if (!settings.isConfigured) {
        SettingsScreen(settings, board.ws.syncedAtMillis, firstRun = true, onSave = vm::saveSettings, onClose = {})
        return
    }

    Box(Modifier.fillMaxSize().background(c.ground)) {
        Column(Modifier.fillMaxSize()) {
            Box(Modifier.weight(1f).statusBarsPadding()) {
                when (tab) {
                    Tab.Tasks -> ListScreen(
                        board = board, filters = filters, name = settings.name, sync = sync,
                        onRefresh = { vm.refresh() }, onQuickView = vm::quickView, onSearch = vm::search,
                        onOpenFilters = { filtersOpen = true }, onOpenTask = vm::open, onComplete = { vm.complete(it) },
                        onOpenSettings = { vm.openSettings(true) },
                    )
                    Tab.Projects -> ProjectsScreen(board, onOpenProject = vm::showProject)
                    Tab.Routines -> RoutinesScreen(board, onOpenTask = vm::open)
                }
                if (tab == Tab.Tasks) NewTaskButton(Modifier.align(Alignment.BottomEnd).padding(end = 16.dp, bottom = 16.dp)) { newTaskOpen = true }
            }
            BottomNav(tab, vm::selectTab)
        }

        AnimatedContent(
            targetState = detail.lastOrNull(),
            transitionSpec = {
                (slideInHorizontally { it / 3 } + fadeIn()) togetherWith (slideOutHorizontally { it / 3 } + fadeOut())
            },
            label = "detail",
        ) { taskId ->
            if (taskId != null) {
                DetailScreen(
                    board = board, taskId = taskId,
                    onBack = { vm.back() }, onOpenTask = vm::open,
                    onComplete = { id -> vm.complete(id); if (id == taskId) vm.back() },
                    onToggleFocus = { vm.toggleFocus(taskId, it) },
                    onNap = { napFor = taskId },
                    onWake = { vm.wake(taskId) },
                    onSomeday = { vm.nap(taskId, NapChoice.Someday); vm.back() },
                    onDelete = { vm.delete(taskId) },
                )
            }
        }

        if (showSettings) {
            SettingsScreen(
                settings, board.ws.syncedAtMillis, firstRun = false, onSave = vm::saveSettings, onClose = { vm.openSettings(false) },
                needsAttention = needsAttention, onRetryNeedsAttention = { vm.retryNeedsAttention() }, onDiscardNeedsAttention = { vm.discardNeedsAttention(needsAttention) },
            )
        }

        SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(bottom = 88.dp)) { data ->
            Snackbar(data, containerColor = c.chipOnBg, contentColor = c.chipOnFg, actionColor = if (c.isDark) c.ink else c.peach, shape = RoundedCornerShape(16.dp))
        }
    }

    if (filtersOpen) FiltersSheet(board, filters, onApply = { vm.setFilters(it); filtersOpen = false }, onDismiss = { filtersOpen = false })
    if (newTaskOpen) QuickAddSheet(
        board, initialProject = filters.projects.singleOrNull(),
        quickAdd = vm.quickAdd,
        onCreate = { d ->
            vm.create(d.title, d.notes, d.projectId, d.plan, d.date, d.time.takeIf { d.date != null }, d.kickoff, d.availableFrom, d.waitingOn)
        },
        onDismiss = { newTaskOpen = false },
    )
    napFor?.let { id ->
        NapSheet(onPick = { choice -> vm.nap(id, choice); napFor = null; vm.back() }, onDismiss = { napFor = null })
    }
}

@Composable
private fun NewTaskButton(modifier: Modifier, onClick: () -> Unit) {
    val c = LocalColors.current
    Row(
        modifier
            .shadow(12.dp, RoundedCornerShape(18.dp), ambientColor = Color(0x381F1B3A), spotColor = Color(0x381F1B3A))
            .height(56.dp)
            .clip(RoundedCornerShape(18.dp))
            .background(c.peach)
            .clickable(role = Role.Button, onClick = onClick)
            .padding(start = 16.dp, end = 20.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(AppIcons.Plus, null, Modifier.size(22.dp), tint = c.onPeach)
        Text("New task", style = Type.button, color = c.onPeach)
    }
}

@Composable
private fun BottomNav(tab: Tab, onSelect: (Tab) -> Unit) {
    val c = LocalColors.current
    Row(
        Modifier.fillMaxWidth().background(c.nav).navigationBarsPadding().height(80.dp).padding(top = 12.dp),
        horizontalArrangement = Arrangement.SpaceAround,
    ) {
        NavItem(AppIcons.Tasks, "Tasks", tab == Tab.Tasks) { onSelect(Tab.Tasks) }
        NavItem(AppIcons.Folder, "Projects", tab == Tab.Projects) { onSelect(Tab.Projects) }
        NavItem(AppIcons.Repeat, "Routines", tab == Tab.Routines) { onSelect(Tab.Routines) }
    }
}

@Composable
private fun NavItem(icon: ImageVector, label: String, selected: Boolean, onClick: () -> Unit) {
    val c = LocalColors.current
    Column(
        Modifier.width(96.dp).clip(RoundedCornerShape(16.dp)).clickable(role = Role.Tab, onClick = onClick).semantics { this.selected = selected },
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        Box(
            Modifier.size(64.dp, 32.dp).clip(RoundedCornerShape(16.dp)).background(if (selected) c.navPill else Color.Transparent),
            contentAlignment = Alignment.Center,
        ) { Icon(icon, null, Modifier.size(22.dp), tint = if (selected) c.ink else c.muted) }
        Text(label, style = Type.tag.copy(fontWeight = if (selected) Type.tag.fontWeight else Type.label.fontWeight), color = if (selected) c.ink else c.muted)
    }
}
