package app.justmaple.aperture.ui

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.tween
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateCentroid
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.lazy.grid.LazyGridState
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.dp
import kotlin.math.roundToInt

private data class PinchedGridAnchor(val index: Int, val key: Any, val offset: Int,
    val centroidX: Float, val fractionX: Float)

/** Keep the touched point fixed in both axes, then settle the grid after release. */
@Composable
internal fun Modifier.gridPinch(
    state: LazyGridState,
    columns: Int,
    onColumns: (Int) -> Unit,
): Modifier {
    val density = LocalDensity.current
    val gap = with(density) { 3.dp.toPx() }
    val padding = with(density) { 4.dp.toPx() }

    var pendingAnchor by remember(state) { mutableStateOf<PinchedGridAnchor?>(null) }
    var pinching by remember(state) { mutableStateOf(false) }
    val horizontal = remember(state) { Animatable(0f) }
    LaunchedEffect(columns, pendingAnchor) {
        pendingAnchor?.let { anchor ->
            // Apply after recomposition installs the new column measurement.
            state.scrollToItem(anchor.index, anchor.offset)
            state.layoutInfo.visibleItemsInfo.firstOrNull { it.key == anchor.key }?.let { item ->
                horizontal.snapTo(anchor.centroidX - padding - item.offset.x - anchor.fractionX * item.size.width)
            }
            pendingAnchor = null
        }
    }
    LaunchedEffect(pinching, pendingAnchor) {
        if (pinching) horizontal.stop()
        else if (pendingAnchor == null) horizontal.animateTo(0f, tween(180))
    }
    val currentColumns = rememberUpdatedState(columns)
    val changeColumns = rememberUpdatedState(onColumns)
    return clipToBounds().pointerInput(state, gap, padding) {
        awaitEachGesture {
            awaitFirstDown(requireUnconsumed = false)
            var accumulator = 1f
            while (true) {
                val event = awaitPointerEvent()
                val pressed = event.changes.filter { it.pressed }
                if (pressed.isEmpty() || event.changes.any { it.isConsumed }) break
                if (pressed.size < 2) continue
                pinching = true
                val zoom = event.calculateZoom()
                if (!zoom.isFinite()) continue
                accumulator *= zoom
                val next = nextGridColumnsForPinch(currentColumns.value, accumulator)
                if (next == currentColumns.value) continue
                val centroid = event.calculateCentroid(useCurrent = true)
                val layout = state.layoutInfo
                val localX = centroid.x - horizontal.value - padding
                val anchor = layout.visibleItemsInfo.firstOrNull { item ->
                    item.key.toString().startsWith("photo:") &&
                        centroid != Offset.Unspecified &&
                        localX >= item.offset.x && localX < item.offset.x + item.size.width &&
                        centroid.y >= item.offset.y && centroid.y < item.offset.y + item.size.height
                }
                if (anchor != null) {
                    val fraction = ((centroid.y - padding - anchor.offset.y) / anchor.size.height.coerceAtLeast(1)).coerceIn(0f, 1f)
                    val cell = ((layout.viewportSize.width - 2 * padding - (next - 1) * gap) / next).toInt().coerceAtLeast(1)
                    val desiredTop = centroid.y - padding - fraction * cell
                    val fractionX = ((localX - anchor.offset.x) / anchor.size.width.coerceAtLeast(1)).coerceIn(0f, 1f)
                    pendingAnchor = PinchedGridAnchor(anchor.index, anchor.key, (-desiredTop).roundToInt(), centroid.x, fractionX)
                }
                changeColumns.value(next)
                accumulator = 1f
                event.changes.forEach { it.consume() }
            }
            pinching = false
        }
    }.graphicsLayer { translationX = horizontal.value }
}
