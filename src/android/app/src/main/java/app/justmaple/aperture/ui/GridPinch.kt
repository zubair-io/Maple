package app.justmaple.aperture.ui

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

/** Keep the photo under the fingers at the same vertical point when its row changes. */
@Composable
internal fun Modifier.gridPinch(
    state: LazyGridState,
    columns: Int,
    onColumns: (Int) -> Unit,
): Modifier {
    var pendingAnchor by remember(state) { mutableStateOf<Pair<Int, Int>?>(null) }
    LaunchedEffect(columns, pendingAnchor) {
        pendingAnchor?.let { (index, offset) ->
            // Apply after recomposition installs the new column measurement.
            state.scrollToItem(index, offset)
            pendingAnchor = null
        }
    }
    val currentColumns = rememberUpdatedState(columns)
    val changeColumns = rememberUpdatedState(onColumns)
    val density = LocalDensity.current
    val gap = with(density) { 3.dp.toPx() }
    val padding = with(density) { 4.dp.toPx() }
    return pointerInput(state, gap, padding) {
        awaitEachGesture {
            awaitFirstDown(requireUnconsumed = false)
            var accumulator = 1f
            while (true) {
                val event = awaitPointerEvent()
                val pressed = event.changes.filter { it.pressed }
                if (pressed.isEmpty() || event.changes.any { it.isConsumed }) break
                if (pressed.size < 2) continue
                val zoom = event.calculateZoom()
                if (!zoom.isFinite()) continue
                accumulator *= zoom
                val next = nextGridColumnsForPinch(currentColumns.value, accumulator)
                if (next == currentColumns.value) continue
                val centroid = event.calculateCentroid(useCurrent = true)
                val layout = state.layoutInfo
                val anchor = layout.visibleItemsInfo.firstOrNull { item ->
                    item.key.toString().startsWith("photo:") &&
                        centroid != Offset.Unspecified &&
                        centroid.x >= item.offset.x && centroid.x < item.offset.x + item.size.width &&
                        centroid.y >= item.offset.y && centroid.y < item.offset.y + item.size.height
                }
                if (anchor != null) {
                    val fraction = ((centroid.y - anchor.offset.y) / anchor.size.height.coerceAtLeast(1)).coerceIn(0f, 1f)
                    val cell = ((layout.viewportSize.width - 2 * padding - (next - 1) * gap) / next).toInt().coerceAtLeast(1)
                    val desiredTop = centroid.y - fraction * cell
                    pendingAnchor = anchor.index to (-desiredTop).roundToInt()
                }
                changeColumns.value(next)
                accumulator = 1f
                event.changes.forEach { it.consume() }
            }
        }
    }
}
