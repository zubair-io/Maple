package app.justmaple.aperture.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculateCentroid
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.foundation.gestures.calculateZoom
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.PointerInputScope
import androidx.compose.ui.input.pointer.positionChanged
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Pure zoom & pan state for the Android Preview and Editor canvases (#5186),
 * mirroring Apple's `CanvasZoomModel`:
 * - [pixelScale] == 0f means Fit; 1.0f means 100% (1:1 image-to-viewport pixels); max is 8.0f.
 * - Snaps back to Fit when pinched below `fitScale * 1.02f`.
 * - Suppresses single-finger pan for [PINCH_COOLDOWN_MS] after a two-finger pinch ends
 *   so lifting one finger slightly before the other never jumps the canvas.
 */
@Stable
class CanvasZoomState(
    initialPixelScale: Float = 0f,
    initialPanX: Float = 0f,
    initialPanY: Float = 0f,
) {
    var pixelScale by mutableFloatStateOf(initialPixelScale)
        private set

    var panX by mutableFloatStateOf(initialPanX)
        private set

    var panY by mutableFloatStateOf(initialPanY)
        private set

    private var pinchEndedAtMs: Long? = null

    val isZoomed: Boolean
        get() = pixelScale > 0f

    fun fitScale(
        imageWidth: Int,
        imageHeight: Int,
        viewportWidth: Float,
        viewportHeight: Float,
    ): Float {
        if (imageWidth <= 0 || imageHeight <= 0 || viewportWidth <= 0f || viewportHeight <= 0f) {
            return 1f
        }
        return min(viewportWidth / imageWidth.toFloat(), viewportHeight / imageHeight.toFloat())
    }

    fun effectiveScale(
        imageWidth: Int,
        imageHeight: Int,
        viewportWidth: Float,
        viewportHeight: Float,
    ): Float {
        val fit = fitScale(imageWidth, imageHeight, viewportWidth, viewportHeight)
        return if (pixelScale <= 0f) fit else pixelScale
    }

    fun zoomFactorOverFit(
        imageWidth: Int,
        imageHeight: Int,
        viewportWidth: Float,
        viewportHeight: Float,
    ): Float {
        val fit = fitScale(imageWidth, imageHeight, viewportWidth, viewportHeight)
        if (fit <= 0f) return 1f
        return if (pixelScale <= 0f) 1f else (pixelScale / fit).coerceAtLeast(1f)
    }

    fun percentage(
        imageWidth: Int,
        imageHeight: Int,
        viewportWidth: Float,
        viewportHeight: Float,
    ): Int =
        (effectiveScale(imageWidth, imageHeight, viewportWidth, viewportHeight) * 100f)
            .roundToInt()
            .coerceAtLeast(1)

    fun badgeLabel(
        imageWidth: Int,
        imageHeight: Int,
        viewportWidth: Float,
        viewportHeight: Float,
    ): String = "${percentage(imageWidth, imageHeight, viewportWidth, viewportHeight)}%"

    fun reset() {
        pixelScale = 0f
        panX = 0f
        panY = 0f
        pinchEndedAtMs = null
    }

    fun applyPinch(
        zoomChange: Float,
        centroidX: Float,
        centroidY: Float,
        imageWidth: Int,
        imageHeight: Int,
        viewportWidth: Float,
        viewportHeight: Float,
        panDeltaX: Float = 0f,
        panDeltaY: Float = 0f,
    ) {
        if (!zoomChange.isFinite() || zoomChange <= 0f) return
        val fit = fitScale(imageWidth, imageHeight, viewportWidth, viewportHeight)
        val oldScale = effectiveScale(imageWidth, imageHeight, viewportWidth, viewportHeight)
        val proposed = (oldScale * zoomChange).coerceAtMost(MAX_PIXEL_SCALE)
        if (proposed <= fit * SNAP_TO_FIT_RATIO) {
            reset()
            return
        }
        val relX = centroidX - viewportWidth / 2f
        val relY = centroidY - viewportHeight / 2f
        val scaleRatio = proposed / oldScale
        val rawPanX = relX - (relX - panX) * scaleRatio + panDeltaX
        val rawPanY = relY - (relY - panY) * scaleRatio + panDeltaY
        pixelScale = proposed
        clampAndSetPan(rawPanX, rawPanY, proposed, imageWidth, imageHeight, viewportWidth, viewportHeight)
    }

    fun endPinch(nowMs: Long) {
        pinchEndedAtMs = nowMs
    }

    fun isInPinchCooldown(nowMs: Long): Boolean {
        val ended = pinchEndedAtMs ?: return false
        return nowMs - ended in 0 until PINCH_COOLDOWN_MS
    }

    fun applyPan(
        deltaX: Float,
        deltaY: Float,
        imageWidth: Int,
        imageHeight: Int,
        viewportWidth: Float,
        viewportHeight: Float,
        nowMs: Long = Long.MAX_VALUE,
    ): Boolean {
        if (!isZoomed) return false
        if (isInPinchCooldown(nowMs)) return false
        val scale = effectiveScale(imageWidth, imageHeight, viewportWidth, viewportHeight)
        clampAndSetPan(
            panX + deltaX,
            panY + deltaY,
            scale,
            imageWidth,
            imageHeight,
            viewportWidth,
            viewportHeight,
        )
        return true
    }

    fun doubleTap(
        tapX: Float,
        tapY: Float,
        imageWidth: Int,
        imageHeight: Int,
        viewportWidth: Float,
        viewportHeight: Float,
    ) {
        if (isZoomed) {
            reset()
            return
        }
        val fit = fitScale(imageWidth, imageHeight, viewportWidth, viewportHeight)
        val targetScale = ONE_TO_ONE_PIXEL_SCALE
        val relX = tapX - viewportWidth / 2f
        val relY = tapY - viewportHeight / 2f
        val scaleRatio = targetScale / fit
        val rawPanX = -relX * (scaleRatio - 1f)
        val rawPanY = -relY * (scaleRatio - 1f)
        pixelScale = targetScale
        pinchEndedAtMs = null
        clampAndSetPan(
            rawPanX,
            rawPanY,
            targetScale,
            imageWidth,
            imageHeight,
            viewportWidth,
            viewportHeight,
        )
    }

    private fun clampAndSetPan(
        candidateX: Float,
        candidateY: Float,
        scale: Float,
        imageWidth: Int,
        imageHeight: Int,
        viewportWidth: Float,
        viewportHeight: Float,
    ) {
        val scaledWidth = imageWidth.toFloat() * scale
        val scaledHeight = imageHeight.toFloat() * scale
        val maxX = max(0f, (scaledWidth - viewportWidth) / 2f)
        val maxY = max(0f, (scaledHeight - viewportHeight) / 2f)
        panX = candidateX.coerceIn(-maxX, maxX)
        panY = candidateY.coerceIn(-maxY, maxY)
    }

    companion object {
        const val ONE_TO_ONE_PIXEL_SCALE = 1.0f
        const val MAX_PIXEL_SCALE = 8.0f
        const val SNAP_TO_FIT_RATIO = 1.02f
        const val PINCH_COOLDOWN_MS = 300L
        const val DOUBLE_TAP_TIMEOUT_MS = 280L
        const val DOUBLE_TAP_SLOP_PX = 48f
        const val SWIPE_PAGE_THRESHOLD_PX = 96f
    }
}

@Composable
fun rememberCanvasZoomState(): CanvasZoomState = remember { CanvasZoomState() }

@Composable
internal fun CanvasZoomBadge(
    label: String,
    isZoomed: Boolean,
    onReset: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Box(
        modifier
            .defaultMinSize(minWidth = 44.dp, minHeight = 44.dp)
            .clickable(enabled = isZoomed, role = Role.Button, onClick = onReset)
            .padding(8.dp)
            .semantics {
                contentDescription = "Zoom to Fit"
                stateDescription = label
                role = Role.Button
            }
            .testTag("canvas-zoom-indicator"),
        contentAlignment = Alignment.Center,
    ) {
        Surface(
            shape = RoundedCornerShape(6.dp),
            color = Color.Black.copy(alpha = 0.58f),
            border =
                BorderStroke(
                    0.5.dp,
                    if (isZoomed) MapleColors.primary.copy(alpha = 0.7f)
                    else MapleColors.borderHi.copy(alpha = 0.4f),
                ),
        ) {
            Text(
                text = label,
                modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                color = if (isZoomed) MapleColors.primary else Color.White,
                fontSize = 10.sp,
                fontWeight = FontWeight.Medium,
                fontFamily = FontFamily.Monospace,
            )
        }
    }
}

internal suspend fun PointerInputScope.detectCanvasZoomPanAndSwipe(
    zoomState: CanvasZoomState,
    imageDimensions: () -> Pair<Int, Int>,
    allowSwipePaging: Boolean,
    onSwipePage: (Int) -> Unit,
    clockMs: () -> Long = System::currentTimeMillis,
) {
    var lastTapTimeMs = -1L
    var lastTapPos = Offset.Zero
    awaitEachGesture {
        val down = awaitFirstDown(requireUnconsumed = false)
        var consumedByChild = down.isConsumed
        val downTimeMs = clockMs()
        val downPos = down.position
        var hadMultiTouch = false
        var totalSingleDragX = 0f
        var totalSingleDragY = 0f
        var maxMovement = 0f

        do {
            val event = awaitPointerEvent()
            if (event.changes.any { it.isConsumed }) {
                consumedByChild = true
            }
            val pressed = event.changes.filter { it.pressed }
            val viewportW = size.width.toFloat().coerceAtLeast(1f)
            val viewportH = size.height.toFloat().coerceAtLeast(1f)
            val (imgW, imgH) = imageDimensions()

            if (pressed.size >= 2) {
                hadMultiTouch = true
                val zoomChange = event.calculateZoom()
                val panChange = event.calculatePan()
                val centroid = event.calculateCentroid(useCurrent = true)
                if (zoomChange != 1f || panChange != Offset.Zero) {
                    zoomState.applyPinch(
                        zoomChange = zoomChange,
                        centroidX = if (centroid != Offset.Unspecified) centroid.x else viewportW / 2f,
                        centroidY = if (centroid != Offset.Unspecified) centroid.y else viewportH / 2f,
                        imageWidth = imgW,
                        imageHeight = imgH,
                        viewportWidth = viewportW,
                        viewportHeight = viewportH,
                        panDeltaX = panChange.x,
                        panDeltaY = panChange.y,
                    )
                    event.changes.forEach { if (it.positionChanged()) it.consume() }
                }
            } else if (pressed.size == 1 && !consumedByChild) {
                if (hadMultiTouch) {
                    hadMultiTouch = false
                    zoomState.endPinch(clockMs())
                }
                val panChange = event.calculatePan()
                maxMovement = max(maxMovement, (pressed.first().position - downPos).getDistance())
                if (panChange != Offset.Zero) {
                    if (zoomState.isZoomed) {
                        val panned =
                            zoomState.applyPan(
                                deltaX = panChange.x,
                                deltaY = panChange.y,
                                imageWidth = imgW,
                                imageHeight = imgH,
                                viewportWidth = viewportW,
                                viewportHeight = viewportH,
                                nowMs = clockMs(),
                            )
                        if (panned) {
                            event.changes.forEach { if (it.positionChanged()) it.consume() }
                        }
                    } else if (allowSwipePaging && !zoomState.isInPinchCooldown(clockMs())) {
                        totalSingleDragX += panChange.x
                        totalSingleDragY += panChange.y
                        if (
                            abs(totalSingleDragX) > abs(totalSingleDragY) * 1.25f &&
                                abs(totalSingleDragX) > 16f
                        ) {
                            event.changes.forEach { if (it.positionChanged()) it.consume() }
                        }
                    }
                }
            }
        } while (event.changes.any { it.pressed })

        val upTimeMs = clockMs()
        if (hadMultiTouch) {
            zoomState.endPinch(upTimeMs)
        } else if (consumedByChild) {
            lastTapTimeMs = -1L
        } else if (
            allowSwipePaging &&
                !zoomState.isZoomed &&
                abs(totalSingleDragX) >= CanvasZoomState.SWIPE_PAGE_THRESHOLD_PX &&
                abs(totalSingleDragX) > abs(totalSingleDragY) * 1.25f
        ) {
            // Swipe left (negative X) advances to next photo (+1); swipe right goes to previous (-1)
            onSwipePage(if (totalSingleDragX < 0f) 1 else -1)
        } else if (maxMovement <= CanvasZoomState.DOUBLE_TAP_SLOP_PX && upTimeMs - downTimeMs <= 250L) {
            if (
                lastTapTimeMs >= 0L &&
                    upTimeMs - lastTapTimeMs <= CanvasZoomState.DOUBLE_TAP_TIMEOUT_MS &&
                    (downPos - lastTapPos).getDistance() <= CanvasZoomState.DOUBLE_TAP_SLOP_PX * 1.5f
            ) {
                val (imgW, imgH) = imageDimensions()
                zoomState.doubleTap(
                    tapX = downPos.x,
                    tapY = downPos.y,
                    imageWidth = imgW,
                    imageHeight = imgH,
                    viewportWidth = size.width.toFloat().coerceAtLeast(1f),
                    viewportHeight = size.height.toFloat().coerceAtLeast(1f),
                )
                lastTapTimeMs = -1L
            } else {
                lastTapTimeMs = upTimeMs
                lastTapPos = downPos
            }
        }
    }
}
