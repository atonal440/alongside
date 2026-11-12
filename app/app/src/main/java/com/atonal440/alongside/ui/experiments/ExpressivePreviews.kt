package com.atonal440.alongside.ui.experiments

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.ExperimentalMaterial3ExpressiveApi
import androidx.compose.material3.MaterialShapes
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.toShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.atonal440.alongside.data.SampleData
import com.atonal440.alongside.domain.Board
import com.atonal440.alongside.ui.components.TaskRow
import com.atonal440.alongside.ui.theme.AlongsideTheme
import com.atonal440.alongside.ui.theme.LocalColors
import com.atonal440.alongside.ui.theme.Type

/*
 * Design sandbox for Material 3 Expressive. Nothing here ships in a screen: open this file in
 * Android Studio and use the Split or Design view to see the previews. Edit a "Variant" and the
 * preview refreshes. Interactive previews (tap, spring motion) need the "Interactive" button on a
 * preview, or run on a device. See docs/android/m3-expressive.md.
 *
 * Written without compiling in the cloud: if Studio flags an expressive API, check the pinned
 * material3 version first (several are @ExperimentalMaterial3ExpressiveApi).
 */

private val rows by lazy {
    val board = Board(SampleData.workspace())
    board.facts.take(4)
}

@Composable
private fun TaskListSample(title: String) {
    val c = LocalColors.current
    Column(Modifier.background(c.ground).padding(vertical = 12.dp)) {
        Text(title, style = Type.section, color = c.muted, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp))
        rows.forEach { f -> TaskRow(f, projectTitle = null, onOpen = {}, onComplete = {}) }
    }
}

/** Step 1: the real task list under the current theme, as the baseline to compare against. */
@Preview(name = "Current", widthDp = 380, showBackground = true)
@Composable
private fun CurrentList() = AlongsideTheme(darkTheme = false) { TaskListSample("CURRENT") }

/** Same list under MaterialExpressiveTheme. Differences are subtle until components adopt it. */
@Preview(name = "Expressive theme", widthDp = 380, showBackground = true)
@Composable
private fun ExpressiveList() = AlongsideTheme(darkTheme = false, expressive = true) { TaskListSample("EXPRESSIVE THEME") }

@Preview(name = "Expressive theme, dark", widthDp = 380, showBackground = true)
@Composable
private fun ExpressiveListDark() = AlongsideTheme(darkTheme = true, expressive = true) { TaskListSample("EXPRESSIVE THEME, DARK") }

/**
 * Step 2: shape and motion on a single control. The check morphs from a rounded blob to a
 * cookie shape and springs when tapped. Use the Interactive button on this preview to try it.
 */
@OptIn(ExperimentalMaterial3ExpressiveApi::class)
@Composable
private fun SpringCheckDemo() {
    val c = LocalColors.current
    var done by remember { mutableStateOf(false) }
    val scale by animateFloatAsState(
        if (done) 1.15f else 1f,
        animationSpec = MaterialTheme.motionScheme.fastSpatialSpec(),
        label = "scale",
    )
    val shape = if (done) MaterialShapes.Cookie9Sided.toShape() else MaterialShapes.Pill.toShape()
    Row(Modifier.background(c.ground).padding(24.dp), horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.CenterVertically) {
        Box(
            Modifier.size(56.dp).scale(scale).clip(shape)
                .background(if (done) c.lime else c.peach)
                .clickable { done = !done },
        )
        Text(if (done) "Done" else "Tap me", style = Type.rowTitle, color = c.ink)
    }
}

@Preview(name = "Spring check", widthDp = 380, showBackground = true)
@Composable
private fun SpringCheckPreview() = AlongsideTheme(darkTheme = false, expressive = true) { SpringCheckDemo() }
