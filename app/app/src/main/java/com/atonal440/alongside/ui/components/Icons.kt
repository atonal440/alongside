package com.atonal440.alongside.ui.components

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

/** Stroke icons lifted from the canvas SVGs (24-unit grid, 2-unit round strokes). */
object AppIcons {
    private fun circle(cx: Float, cy: Float, r: Float) = "M${cx - r} ${cy}a$r $r 0 1 0 ${2 * r} 0a$r $r 0 1 0 ${-2 * r} 0"

    private fun icon(name: String, vararg paths: String, stroke: Float = 2f, filled: Boolean = false) =
        ImageVector.Builder(name, 24.dp, 24.dp, 24f, 24f).apply {
            paths.forEach { d ->
                addPath(
                    pathData = addPathNodes(d),
                    fill = if (filled) SolidColor(Color.Black) else null,
                    stroke = SolidColor(Color.Black),
                    strokeLineWidth = stroke,
                    strokeLineCap = StrokeCap.Round,
                    strokeLineJoin = StrokeJoin.Round,
                )
            }
        }.build()

    val Search = icon("search", circle(11f, 11f, 6.5f), "M16 16l5 5")
    val Filters = icon("filters", "M4 7h10M18 7h2M4 17h2M10 17h10", circle(16f, 7f, 2f), circle(8f, 17f, 2f))
    private const val STAR = "M12 3l2.7 6 6.3.6-4.8 4.2 1.5 6.2-5.7-3.2-5.7 3.2 1.5-6.2L3 9.6 9.3 9z"
    val Star = icon("star", STAR)
    val StarFilled = icon("star_filled", STAR, filled = true)
    val Moon = icon("moon", "M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z")
    val Lock = icon("lock", "M7 11h10a2 2 0 012 2v5a2 2 0 01-2 2H7a2 2 0 01-2-2v-5a2 2 0 012-2zM8 11V8a4 4 0 018 0v3")
    val ChevronRight = icon("chevron_right", "M9 6l6 6-6 6")
    val Plus = icon("plus", "M12 5v14M5 12h14", stroke = 2.5f)
    val Tasks = icon("tasks", "M4 7h16M4 12h16M4 17h10")
    val Folder = icon("folder", "M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z")
    val Repeat = icon("repeat", "M4 11V9a3 3 0 013-3h11l-3-3M20 13v2a3 3 0 01-3 3H6l3 3")
    val Back = icon("back", "M15 5l-7 7 7 7")
    val More = icon("more", circle(12f, 5f, 1.2f), circle(12f, 12f, 1.2f), circle(12f, 19f, 1.2f), filled = true)
    val Flag = icon("flag", "M6 21V4M6 5h11l-2 4 2 4H6")
    val Calendar = icon("calendar", "M7 5h10a3 3 0 013 3v9a3 3 0 01-3 3H7a3 3 0 01-3-3V8a3 3 0 013-3zM4 10h16M8 3v4M16 3v4")
    val Check = icon("check", "M5 12.5l4.5 4.5L19 7.5", stroke = 2.5f)
    val Close = icon("close", "M6 6l12 12M18 6L6 18")
    val Notes = icon("notes", "M6 4h12v16H6zM9 9h6M9 13h6M9 17h3")
    val Sync = icon("sync", "M20 11a8 8 0 00-14.5-4.5M4 4v3h3M4 13a8 8 0 0014.5 4.5M20 20v-3h-3")
    val Sun = icon("sun", circle(12f, 12f, 4f), "M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4")
    val Trash = icon("trash", "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13")
}
