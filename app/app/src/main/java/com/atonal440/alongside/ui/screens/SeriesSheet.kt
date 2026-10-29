package com.atonal440.alongside.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.atonal440.alongside.data.Duty
import com.atonal440.alongside.data.TaskLimits
import com.atonal440.alongside.domain.nextOccurrenceLabel
import com.atonal440.alongside.domain.recurrenceLabel
import com.atonal440.alongside.ui.components.OutlineButton
import com.atonal440.alongside.ui.components.PrimaryButton
import com.atonal440.alongside.ui.theme.LocalColors
import com.atonal440.alongside.ui.theme.Type

/**
 * A repeating series: the template every new occurrence copies, and whether it is running. The schedule itself cannot change
 * once a series exists (the worker keeps it fixed), so a different rhythm means ending this one and starting another.
 * Edits reach occurrences that have not been made yet; tasks already on the list are not touched.
 */
@Composable
fun SeriesSheet(
    duty: Duty,
    onSave: (title: String, notes: String?, plan: Boolean, catchUpAll: Boolean) -> Unit,
    onStatus: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    val c = LocalColors.current
    var title by remember(duty.id) { mutableStateOf(duty.title) }
    var notes by remember(duty.id) { mutableStateOf(duty.notes.orEmpty()) }
    var plan by remember(duty.id) { mutableStateOf(duty.task_type == "plan") }
    var catchUpAll by remember(duty.id) { mutableStateOf(duty.catch_up == "all") }
    var confirmEnd by remember(duty.id) { mutableStateOf(false) }
    val titleTooLong = title.trim().length > TaskLimits.TITLE_MAX
    val notesTooLong = notes.trim().length > TaskLimits.NOTES_MAX
    val changed = title.trim() != duty.title || notes.trim() != duty.notes.orEmpty() || plan != (duty.task_type == "plan") || catchUpAll != (duty.catch_up == "all")
    val canSave = title.isNotBlank() && !titleTooLong && !notesTooLong && changed

    AlongsideSheet(onDismiss) {
        Column(Modifier.navigationBarsPadding().imePadding().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp)) {
            Text("Repeating task", style = Type.sheetTitle, color = c.ink, modifier = Modifier.padding(top = 8.dp, bottom = 4.dp))
            val schedule = listOfNotNull(
                recurrenceLabel(duty.rrule) ?: "Repeats",
                when {
                    duty.isEnded -> "Ended"
                    duty.isPaused -> "Paused"
                    else -> nextOccurrenceLabel(duty)?.let { "next $it" }
                },
            ).joinToString(" · ")
            Text(schedule, style = Type.meta, color = c.muted, modifier = Modifier.padding(bottom = 14.dp))
            Field(title, { title = it }, "What repeats", Type.body)
            if (titleTooLong) LimitNote("Titles can be up to ${TaskLimits.TITLE_MAX} characters (this is ${title.trim().length}).")
            Field(notes, { notes = it }, "Notes (optional)", Type.body, singleLine = false, modifier = Modifier.padding(top = 10.dp))
            if (notesTooLong) LimitNote("Notes can be up to ${TaskLimits.NOTES_MAX} characters (these are ${notes.trim().length}).")
            Column(Modifier.padding(top = 18.dp), verticalArrangement = Arrangement.spacedBy(18.dp)) {
                Column {
                    SheetLabel("Kind")
                    Segmented(listOf("Action", "Plan"), if (plan) 1 else 0) { plan = it == 1 }
                }
                Column {
                    SheetLabel("If some get missed")
                    Segmented(listOf("Only the latest", "Every one"), if (catchUpAll) 1 else 0) { catchUpAll = it == 1 }
                }
            }
            Text("Changes apply to the ones still to come.", style = Type.meta, color = c.muted, modifier = Modifier.padding(top = 10.dp))
            PrimaryButton(
                "Save", onClick = { onSave(title.trim(), notes.trim().takeIf { it.isNotEmpty() }, plan, catchUpAll); onDismiss() },
                enabled = canSave, modifier = Modifier.fillMaxWidth().padding(top = 18.dp),
            )
            // The worker refuses any status change once a series has ended.
            if (!duty.isEnded) OutlineButton(
                if (duty.isPaused) "Resume" else "Pause",
                onClick = { onStatus(if (duty.isPaused) "active" else "paused"); onDismiss() },
                modifier = Modifier.fillMaxWidth().padding(top = 10.dp),
            )
            if (duty.isEnded) {
                Spacer(Modifier.height(24.dp))
            } else if (!confirmEnd) {
                OutlineButton("End this repeat", onClick = { confirmEnd = true }, modifier = Modifier.fillMaxWidth().padding(top = 10.dp, bottom = 24.dp))
            } else {
                Text("Ending can't be undone, and no more will be made. Tasks already made stay.", style = Type.meta, color = c.urgentFg, modifier = Modifier.padding(top = 12.dp))
                OutlineButton("Yes, end it", onClick = { onStatus("ended"); onDismiss() }, modifier = Modifier.fillMaxWidth().padding(top = 10.dp, bottom = 24.dp))
            }
        }
    }
}
