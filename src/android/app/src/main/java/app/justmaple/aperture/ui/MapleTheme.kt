package app.justmaple.aperture.ui

import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.sp
import app.justmaple.aperture.generated.UiTokens

object MapleColors {
    private fun color(value: String) = Color(android.graphics.Color.parseColor(value))

    val background = color(UiTokens.bg)
    val surface = color(UiTokens.surface)
    val raised = color(UiTokens.surface_alt)
    val canvas = color(UiTokens.image_canvas)
    val sidebar = color(UiTokens.sidebar)
    val text = color(UiTokens.text_main)
    val muted = color(UiTokens.text_muted)
    val border = color(UiTokens.border)
    val borderHi = color(UiTokens.border_hi)
    val primary = color(UiTokens.primary)
    val primaryDim = color(UiTokens.primary_dim)
    val star = color(UiTokens.star)
    val error = color(UiTokens.error_text)
}

@Composable
fun MapleTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme =
            darkColorScheme(
                primary = MapleColors.primary,
                onPrimary = MapleColors.text,
                primaryContainer = MapleColors.primaryDim,
                onPrimaryContainer = MapleColors.text,
                secondary = MapleColors.primary,
                onSecondary = MapleColors.text,
                secondaryContainer = MapleColors.primaryDim,
                onSecondaryContainer = MapleColors.text,
                tertiary = MapleColors.primary,
                onTertiary = MapleColors.text,
                tertiaryContainer = MapleColors.primaryDim,
                onTertiaryContainer = MapleColors.text,
                background = MapleColors.background,
                onBackground = MapleColors.text,
                surface = MapleColors.surface,
                onSurface = MapleColors.text,
                surfaceVariant = MapleColors.raised,
                onSurfaceVariant = MapleColors.muted,
                outline = MapleColors.border,
                outlineVariant = MapleColors.border,
                surfaceTint = MapleColors.primary,
                surfaceContainer = MapleColors.surface,
                surfaceContainerHigh = MapleColors.raised,
                surfaceContainerHighest = MapleColors.raised,
                surfaceContainerLow = MapleColors.surface,
                surfaceContainerLowest = MapleColors.background,
                error = MapleColors.error,
            ),
        typography =
            Typography(
                bodyMedium =
                    TextStyle(
                        fontFamily = FontFamily.SansSerif,
                        fontSize = 13.sp,
                        lineHeight = 19.sp,
                    ),
                labelMedium = TextStyle(fontFamily = FontFamily.SansSerif, fontSize = 12.sp),
                titleMedium = TextStyle(fontFamily = FontFamily.SansSerif, fontSize = 17.sp),
                labelSmall = TextStyle(fontFamily = FontFamily.Monospace, fontSize = 10.sp),
            ),
    ) {
        Surface(color = MapleColors.background, contentColor = MapleColors.text, content = content)
    }
}
