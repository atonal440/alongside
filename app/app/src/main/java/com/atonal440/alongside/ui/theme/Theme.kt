package com.atonal440.alongside.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.ExperimentalTextApi
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.atonal440.alongside.R

/** The palette from the "Alongside for Android" canvas: ink on lavender, peach for action, lime for done. */
@Immutable
data class AlongsideColors(
    val ink: Color,
    val ground: Color,
    val surface: Color,
    val card: Color,
    val muted: Color,
    val line: Color,
    val soft: Color,
    val nav: Color,
    val navPill: Color,
    val lavender: Color,
    val peach: Color,
    val onPeach: Color,
    val lime: Color,
    val urgentBg: Color,
    val urgentFg: Color,
    val planBg: Color,
    val planFg: Color,
    val segOff: Color,
    val divider: Color,
    val chipOnBg: Color,
    val chipOnFg: Color,
    val noteBg: Color,
    val noteFg: Color,
    val noteAccent: Color,
    val noteMuted: Color,
    val noteRule: Color,
    val scrim: Color,
    val isDark: Boolean,
)

val LightPalette = AlongsideColors(
    ink = Color(0xFF1F1B3A),
    ground = Color(0xFFF4F2FB),
    surface = Color(0xFFFBF9FF),
    card = Color(0xFFFFFFFF),
    muted = Color(0xFF5B5780),
    line = Color(0xFFCFC9E8),
    soft = Color(0xFFE9E5F7),
    nav = Color(0xFFECE8F8),
    navPill = Color(0xFFCFC5F5),
    lavender = Color(0xFFCFC5F5),
    peach = Color(0xFFFF8A4C),
    onPeach = Color(0xFF1F1B3A),
    lime = Color(0xFFBDEB6B),
    urgentBg = Color(0xFFFFD9C7),
    urgentFg = Color(0xFF8A2B0E),
    planBg = Color(0xFFDCEBFF),
    planFg = Color(0xFF17345C),
    segOff = Color(0xFFD5CFEC),
    divider = Color(0xFFECE8F8),
    chipOnBg = Color(0xFF1F1B3A),
    chipOnFg = Color(0xFFFFFFFF),
    noteBg = Color(0xFF1F1B3A),
    noteFg = Color(0xFFF3F0FF),
    noteAccent = Color(0xFFFFB48A),
    noteMuted = Color(0xFFB9B3DD),
    noteRule = Color(0xFF4A4377),
    scrim = Color(0x731F1B3A),
    isDark = false,
)

val DarkPalette = AlongsideColors(
    ink = Color(0xFFF3F0FF),
    ground = Color(0xFF14122B),
    surface = Color(0xFF1C1936),
    card = Color(0xFF25213F),
    muted = Color(0xFFB9B3DD),
    line = Color(0xFF4A4377),
    soft = Color(0xFF25213F),
    nav = Color(0xFF1C1936),
    navPill = Color(0xFF4A3F86),
    lavender = Color(0xFF3B3470),
    peach = Color(0xFFFF8A4C),
    onPeach = Color(0xFF1F1B3A),
    lime = Color(0xFFBDEB6B),
    urgentBg = Color(0xFF5A2A2F),
    urgentFg = Color(0xFFFFD9D2),
    planBg = Color(0xFF233A63),
    planFg = Color(0xFFCFE3FF),
    segOff = Color(0xFF4A4377),
    divider = Color(0xFF332E57),
    chipOnBg = Color(0xFFBDEB6B),
    chipOnFg = Color(0xFF1F1B3A),
    noteBg = Color(0xFF2E2952),
    noteFg = Color(0xFFF3F0FF),
    noteAccent = Color(0xFFFFB48A),
    noteMuted = Color(0xFFB9B3DD),
    noteRule = Color(0xFF4A4377),
    scrim = Color(0x99000000),
    isDark = true,
)

val LocalColors = staticCompositionLocalOf { LightPalette }

@OptIn(ExperimentalTextApi::class)
private fun figtree(weight: Int) = Font(
    R.font.figtree, FontWeight(weight),
    variationSettings = FontVariation.Settings(FontVariation.weight(weight)),
)

@OptIn(ExperimentalTextApi::class)
private fun bricolage(weight: Int) = Font(
    R.font.bricolage_grotesque, FontWeight(weight),
    variationSettings = FontVariation.Settings(FontVariation.weight(weight), FontVariation.Setting("opsz", 36f)),
)

val Figtree = FontFamily(figtree(500), figtree(600), figtree(700))
val Bricolage = FontFamily(bricolage(600), bricolage(700))

/** Type roles used across screens, named for what they do rather than their size. */
object Type {
    val display = TextStyle(fontFamily = Bricolage, fontWeight = FontWeight.Bold, fontSize = 28.sp, lineHeight = 31.sp)
    val title = TextStyle(fontFamily = Bricolage, fontWeight = FontWeight.Bold, fontSize = 30.sp, lineHeight = 33.sp)
    val sheetTitle = TextStyle(fontFamily = Bricolage, fontWeight = FontWeight.Bold, fontSize = 24.sp, lineHeight = 28.sp)
    val note = TextStyle(fontFamily = Bricolage, fontWeight = FontWeight.SemiBold, fontSize = 19.sp, lineHeight = 25.sp)
    val body = TextStyle(fontFamily = Figtree, fontWeight = FontWeight.Medium, fontSize = 15.sp, lineHeight = 20.sp)
    val rowTitle = TextStyle(fontFamily = Figtree, fontWeight = FontWeight.SemiBold, fontSize = 16.sp, lineHeight = 20.sp)
    val label = TextStyle(fontFamily = Figtree, fontWeight = FontWeight.SemiBold, fontSize = 14.sp, lineHeight = 14.sp)
    val meta = TextStyle(fontFamily = Figtree, fontWeight = FontWeight.Medium, fontSize = 12.5.sp, lineHeight = 15.sp)
    val tag = TextStyle(fontFamily = Figtree, fontWeight = FontWeight.Bold, fontSize = 12.sp, lineHeight = 14.sp)
    val section = TextStyle(fontFamily = Figtree, fontWeight = FontWeight.Bold, fontSize = 12.sp, lineHeight = 12.sp, letterSpacing = 0.96.sp)
    val button = TextStyle(fontFamily = Figtree, fontWeight = FontWeight.Bold, fontSize = 16.sp, lineHeight = 16.sp)
}

@Composable
fun AlongsideTheme(darkTheme: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
    val palette = if (darkTheme) DarkPalette else LightPalette
    val scheme = if (darkTheme) {
        darkColorScheme(
            primary = palette.peach, onPrimary = palette.onPeach, background = palette.ground, onBackground = palette.ink,
            surface = palette.surface, onSurface = palette.ink, surfaceContainerLow = palette.surface,
            surfaceContainer = palette.card, surfaceContainerHigh = palette.card, inverseSurface = palette.ink,
            inverseOnSurface = palette.ground, inversePrimary = palette.lime, outline = palette.line,
        )
    } else {
        lightColorScheme(
            primary = palette.peach, onPrimary = palette.onPeach, background = palette.ground, onBackground = palette.ink,
            surface = palette.surface, onSurface = palette.ink, surfaceContainerLow = palette.surface,
            surfaceContainer = palette.card, surfaceContainerHigh = palette.card, inverseSurface = palette.ink,
            inverseOnSurface = palette.ground, inversePrimary = palette.lime, outline = palette.line,
        )
    }
    val base = Typography()
    val typography = Typography(
        bodyLarge = base.bodyLarge.copy(fontFamily = Figtree),
        bodyMedium = base.bodyMedium.copy(fontFamily = Figtree),
        labelLarge = base.labelLarge.copy(fontFamily = Figtree, fontWeight = FontWeight.Bold),
        titleLarge = base.titleLarge.copy(fontFamily = Bricolage),
    )
    CompositionLocalProvider(LocalColors provides palette) {
        MaterialTheme(colorScheme = scheme, typography = typography, content = content)
    }
}
