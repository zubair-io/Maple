package app.justmaple.aperture.ui

import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.graphics.Rect
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.window.layout.FoldingFeature
import androidx.window.layout.WindowInfoTracker

enum class PostureKind {
    Normal,
    /**
     * Vertical fold or dual-screen hinge (Surface Duo spanned dual-portrait or
     * Galaxy Z Fold / Pixel Fold in Book / separating vertical fold).
     */
    BookVerticalSplit,
    /**
     * Horizontal half-opened fold (Galaxy Z Fold / Pixel Fold in Tabletop / Laptop posture).
     */
    TabletopHorizontalSplit,
}

@Immutable
data class FoldablePosture(
    val kind: PostureKind = PostureKind.Normal,
    val primaryPaneSpanDp: Dp = 0.dp,
    val hingeSpanDp: Dp = 0.dp,
    val secondaryPaneSpanDp: Dp = 0.dp,
    val windowWidthDp: Dp = 0.dp,
    val windowHeightDp: Dp = 0.dp,
    val smallestScreenWidthDp: Int = 0,
) {
    val isSplit: Boolean
        get() = kind != PostureKind.Normal

    val isBookSplit: Boolean
        get() = kind == PostureKind.BookVerticalSplit

    val isTabletopSplit: Boolean
        get() = kind == PostureKind.TabletopHorizontalSplit

    /**
     * True on tablets (`smallestScreenWidthDp >= 600`), unfolded foldables laid flat
     * (`windowWidthDp >= 600.dp && windowHeightDp >= 500.dp`), and dual-screen / Book postures.
     * Standard phones rotated to landscape have `windowHeightDp < 480.dp` and stay in phone mode.
     */
    val isWideLayout: Boolean
        get() =
            isBookSplit ||
                smallestScreenWidthDp >= 600 ||
                (windowWidthDp >= 600.dp && windowHeightDp >= 500.dp)

    val canPinSourcesSidebar: Boolean
        get() = isWideLayout && !isBookSplit && windowWidthDp >= 1000.dp

    val canInlineInfoPanel: Boolean
        get() = isWideLayout && !isBookSplit && windowWidthDp >= 900.dp
}

val LocalFoldablePosture = compositionLocalOf<FoldablePosture?> { null }

/**
 * Computes the adaptive [FoldablePosture] from window metrics and an optional [FoldingFeature]
 * bounds rectangle (#5187).
 */
fun computeFoldablePosture(
    windowWidthPx: Int,
    windowHeightPx: Int,
    density: Float,
    smallestScreenWidthDp: Int,
    foldBoundsPx: Rect? = null,
    foldOrientationVertical: Boolean = true,
    foldIsHalfOpened: Boolean = false,
    foldIsSeparating: Boolean = false,
): FoldablePosture {
    val safeDensity = if (density > 0f) density else 1f
    val widthDp = (windowWidthPx / safeDensity).dp
    val heightDp = (windowHeightPx / safeDensity).dp
    if (foldBoundsPx != null && (foldIsSeparating || foldIsHalfOpened)) {
        if (foldOrientationVertical) {
            val leftDp = foldBoundsPx.left / safeDensity
            val hingeDp = foldBoundsPx.width().coerceAtLeast(0) / safeDensity
            val rightDp = (windowWidthPx - foldBoundsPx.right) / safeDensity
            if (leftDp >= MIN_BOOK_PANE_DP && rightDp >= MIN_BOOK_PANE_DP) {
                return FoldablePosture(
                    kind = PostureKind.BookVerticalSplit,
                    primaryPaneSpanDp = leftDp.dp,
                    hingeSpanDp = hingeDp.dp,
                    secondaryPaneSpanDp = rightDp.dp,
                    windowWidthDp = widthDp,
                    windowHeightDp = heightDp,
                    smallestScreenWidthDp = smallestScreenWidthDp,
                )
            }
        } else if (foldIsHalfOpened || foldBoundsPx.height() > 0) {
            val topDp = foldBoundsPx.top / safeDensity
            val hingeDp = foldBoundsPx.height().coerceAtLeast(0) / safeDensity
            val bottomDp = (windowHeightPx - foldBoundsPx.bottom) / safeDensity
            if (topDp >= MIN_TABLETOP_PANE_DP && bottomDp >= MIN_TABLETOP_PANE_DP) {
                return FoldablePosture(
                    kind = PostureKind.TabletopHorizontalSplit,
                    primaryPaneSpanDp = topDp.dp,
                    hingeSpanDp = hingeDp.dp,
                    secondaryPaneSpanDp = bottomDp.dp,
                    windowWidthDp = widthDp,
                    windowHeightDp = heightDp,
                    smallestScreenWidthDp = smallestScreenWidthDp,
                )
            }
        }
    }
    return FoldablePosture(
        kind = PostureKind.Normal,
        windowWidthDp = widthDp,
        windowHeightDp = heightDp,
        smallestScreenWidthDp = smallestScreenWidthDp,
    )
}

@Composable
internal fun rememberFoldablePosture(): FoldablePosture {
    LocalFoldablePosture.current?.let { return it }
    val configuration = LocalConfiguration.current
    val density = LocalDensity.current.density
    val context = LocalContext.current
    val activity = remember(context) { context.findActivity() }
    var foldFeature by remember(activity) { mutableStateOf<FoldingFeature?>(null) }

    LaunchedEffect(activity) {
        if (activity != null) {
            WindowInfoTracker.getOrCreate(activity).windowLayoutInfo(activity).collect { info ->
                foldFeature = info.displayFeatures.filterIsInstance<FoldingFeature>().firstOrNull()
            }
        }
    }

    val widthPx = (configuration.screenWidthDp * density).toInt()
    val heightPx = (configuration.screenHeightDp * density).toInt()
    val feature = foldFeature
    return computeFoldablePosture(
        windowWidthPx = widthPx,
        windowHeightPx = heightPx,
        density = density,
        smallestScreenWidthDp = configuration.smallestScreenWidthDp,
        foldBoundsPx = feature?.bounds,
        foldOrientationVertical = feature?.orientation == FoldingFeature.Orientation.VERTICAL,
        foldIsHalfOpened = feature?.state == FoldingFeature.State.HALF_OPENED,
        foldIsSeparating = feature?.isSeparating == true,
    )
}

private tailrec fun Context.findActivity(): Activity? =
    when (this) {
        is Activity -> this
        is ContextWrapper -> baseContext.findActivity()
        else -> null
    }

private const val MIN_BOOK_PANE_DP = 240f
private const val MIN_TABLETOP_PANE_DP = 180f
