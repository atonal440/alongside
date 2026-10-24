package com.atonal440.alongside.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import com.atonal440.alongside.data.Repository
import com.atonal440.alongside.data.Settings
import com.atonal440.alongside.domain.Board
import com.atonal440.alongside.domain.Filters
import com.atonal440.alongside.domain.NapChoice
import com.atonal440.alongside.domain.Show
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import java.time.LocalDate

enum class Tab { Tasks, Projects, Routines }

/** A completed task the snackbar can still take back. */
data class UndoableCompletion(val taskId: String, val title: String, val spawnedId: String?)

class AppViewModel(app: Application) : AndroidViewModel(app) {
    val repo = Repository.get(app)

    val settings = repo.settings
    val sync = repo.sync
    /** Naps end, focus lapses and windows open with no data change, so the board also rebuilds every minute. */
    private val minuteTicks = flow {
        while (true) {
            emit(Unit)
            delay(60_000)
        }
    }

    val board: StateFlow<Board> = combine(repo.workspace, minuteTicks) { ws, _ -> Board(ws) }
        .stateIn(viewModelScope, SharingStarted.Eagerly, Board(repo.workspace.value))

    private val _filters = MutableStateFlow(Filters())
    val filters: StateFlow<Filters> = _filters.asStateFlow()

    private val _tab = MutableStateFlow(Tab.Tasks)
    val tab: StateFlow<Tab> = _tab.asStateFlow()

    /** Task ids opened in detail, newest last; the back button pops one. */
    private val _detail = MutableStateFlow<List<String>>(emptyList())
    val detail: StateFlow<List<String>> = _detail.asStateFlow()

    private val _showSettings = MutableStateFlow(false)
    val showSettings: StateFlow<Boolean> = _showSettings.asStateFlow()

    /** Set when a widget's "Add" button launched the app; the shell opens the new-task sheet. */
    val newTaskRequested = MutableStateFlow(false)

    val undo = MutableSharedFlow<UndoableCompletion>(extraBufferCapacity = 4)
    val messages = repo.messages

    init {
        viewModelScope.launch { repo.refresh() }
    }

    fun refresh() = viewModelScope.launch { repo.refresh() }

    fun selectTab(tab: Tab) { _tab.value = tab }
    fun open(taskId: String) { _detail.update { it + taskId } }
    fun back(): Boolean {
        if (_detail.value.isNotEmpty()) { _detail.update { it.dropLast(1) }; return true }
        if (_showSettings.value) { _showSettings.value = false; return true }
        if (_tab.value != Tab.Tasks) { _tab.value = Tab.Tasks; return true }
        return false
    }
    fun openSettings(open: Boolean) { _showSettings.value = open }

    fun setFilters(filters: Filters) { _filters.value = filters }
    fun quickView(show: Show) { _filters.update { it.copy(show = setOf(show)) } }
    fun search(query: String) { _filters.update { it.copy(query = query) } }

    fun showProject(projectKey: String) {
        _filters.value = Filters(projects = setOf(projectKey))
        _tab.value = Tab.Tasks
    }

    fun complete(taskId: String) = viewModelScope.launch {
        val title = repo.workspace.value.task(taskId)?.title ?: return@launch
        val spawned = repo.complete(taskId)
        undo.tryEmit(UndoableCompletion(taskId, title, spawned))
    }

    fun undoComplete(item: UndoableCompletion) = viewModelScope.launch { repo.reopen(item.taskId, item.spawnedId) }
    fun toggleFocus(taskId: String, focused: Boolean) = viewModelScope.launch { repo.setFocus(taskId, focused) }
    fun nap(taskId: String, choice: NapChoice) = viewModelScope.launch { repo.nap(taskId, choice.until()) }
    fun wake(taskId: String) = viewModelScope.launch { repo.wake(taskId) }
    fun delete(taskId: String) = viewModelScope.launch {
        _detail.update { stack -> stack.filterNot { it == taskId } }
        repo.delete(taskId)
    }

    fun create(title: String, notes: String?, projectId: String?, plan: Boolean, due: LocalDate?) = viewModelScope.launch {
        repo.create(title.trim(), notes?.trim()?.takeIf { it.isNotEmpty() }, projectId, plan, due)
    }

    fun saveSettings(settings: Settings) {
        repo.updateSettings(settings)
        _showSettings.value = false
        viewModelScope.launch { repo.refresh() }
    }
}
