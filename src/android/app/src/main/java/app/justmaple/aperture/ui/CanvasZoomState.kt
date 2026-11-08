package app.justmaple.aperture.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
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
import app.justmaple.aperture.data.NativeBridge
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Zoom & pan state for the Android Preview and Editor canvases. The rules are the shared
 * `raw_core::canvas::CanvasZoomModel` (#5714), reached through [NativeBridge.canvasZoom]: this
 * class owns the model as a plain `DoubleArray`, hands it to each transition, and mirrors the
 * scale and pan into Compose state. Canvas units are Compose pixels.
 * - [pixelScale] == 0f means Fit; 1.0f means 100% (one image pixel per screen pixel); max 8.0f.
 * - Pinch settles on fit or fill within 4%, and zooms out to half of fit.
 * - Suppresses single-finger pan for [PINCH_COOLDOWN_MS] after a two-finger pinch ends
 *   so lifting one finger slightly before the other never jumps the canvas.
 */
@Stable
class CanvasZoomState {
    private val model = DoubleArray(STATE_LEN)

    var pixelScale by mutableFloatStateOf(0f)
        private set

    var panX by mutableFloatStateOf(0f)
        private set

    var panY by mutableFloatStateOf(0f)
        private set

    private var pinchEndedAtMs: Long? = null
    private var anchorX = 0f
    private var anchorY = 0f

    val isZoomed: Boolean
        get() = pixelScale > 0f

    fun fitScale(imageWidth: Int, imageHeight: Int, viewportWidth: Float, viewportHeight: Float): Float =
        query(QUERY_FIT_SCALE, imageWidth, imageHeight, viewportWidth, viewportHeight).toFloat()

    fun effectiveScale(
        imageWidth: Int,
        imageHeight: Int,
        viewportWidth: Float,
        viewportHeight: Float,
    ): Float = query(QUERY_EFFECTIVE_SCALE, imageWidth, imageHeight, viewportWidth, viewportHeight).toFloat()

    fun zoomFactorOverFit(
        imageWidth: Int,
        imageHeight: Int,
        viewportWidth: Float,
        viewportHeight: Float,
    ): Float {
        if (!isZoomed) return 1f
        val fit = fitScale(imageWidth, imageHeight, viewportWidth, viewportHeight)
        return effectiveScale(imageWidth, imageHeight, viewportWidth, viewportHeight) / fit
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

    /** What a badge tap does: the next stop in fit → fill → 100%. */
    fun nextStopDescription(
        imageWidth: Int,
        imageHeight: Int,
        viewportWidth: Float,
        viewportHeight: Float,
    ): String =
        when (query(QUERY_NEXT_STOP, imageWidth, imageHeight, viewportWidth, viewportHeight).toInt()) {
            STOP_FILL -> "Zoom to Fill"
            STOP_ACTUAL_SIZE -> "Zoom to 100%"
            else -> "Zoom to Fit"
        }

    /** Fit: the shared model's fit state is all zeros (`CanvasZoomModel::default`). */
    fun reset() {
        model.fill(0.0)
        pinchEndedAtMs = null
        publish()
    }

    /** One pinch frame; [magnification] is cumulative since the pinch began. */
    fun pinchChanged(
        magnification: Float,
        centroidX: Float,
        centroidY: Float,
        imageWidth: Int,
        imageHeight: Int,
        viewportWidth: Float,
        viewportHeight: Float,
    ) {
        anchorX = centroidX
        anchorY = centroidY
        transition(OP_PINCH_CHANGED, imageWidth, imageHeight, viewportWidth, viewportHeight,
            magnification.toDouble(), centroidX.toDouble(), centroidY.toDouble())
    }

    fun pinchEnded(
        magnification: Float,
        nowMs: Long,
        imageWidth: Int,
        imageHeight: Int,
        viewportWidth: Float,
        viewportHeight: Float,
    ) {
        transition(OP_PINCH_ENDED, imageWidth, imageHeight, viewportWidth, viewportHeight,
            magnification.toDouble())
        pinchEndedAtMs = nowMs
    }

    fun isInPinchCooldown(nowMs: Long): Boolean {
        val ended = pinchEndedAtMs ?: return false
        return nowMs - ended in 0 until PINCH_COOLDOWN_MS
    }

    /**
     * One drag frame; [translationX]/[translationY] are cumulative since the drag began. Returns
     * whether the drag panned the image. During the post-pinch cooldown the translation only
     * becomes the baseline, so the pan resumes without a jump.
     */
    fun dragChanged(
        translationX: Float,
        translationY: Float,
        imageWidth: Int,
        imageHeight: Int,
        viewportWidth: Float,
        viewportHeight: Float,
        nowMs: Long = Long.MAX_VALUE,
    ): Boolean {
        val op = if (isInPinchCooldown(nowMs)) OP_REBASE_DRAG else OP_DRAG_CHANGED
        val result = transition(op, imageWidth, imageHeight, viewportWidth, viewportHeight,
            translationX.toDouble(), translationY.toDouble())
        return op == OP_DRAG_CHANGED && result == 1
    }

    fun dragEnded() {
        transition(OP_DRAG_ENDED, 0, 0, 0f, 0f)
    }

    /** Fit ↔ 100%, zooming in anchored at the tap. */
    fun doubleTap(
        tapX: Float,
        tapY: Float,
        imageWidth: Int,
        imageHeight: Int,
        viewportWidth: Float,
        viewportHeight: Float,
    ) {
        anchorX = tapX
        anchorY = tapY
        pinchEndedAtMs = null
        transition(OP_DOUBLE_TAP, imageWidth, imageHeight, viewportWidth, viewportHeight,
            tapX.toDouble(), tapY.toDouble())
    }

    /** Badge tap: the next stop in fit → fill → 100%; a free scale returns to fit. */
    fun advanceStop(imageWidth: Int, imageHeight: Int, viewportWidth: Float, viewportHeight: Float) {
        anchorX = viewportWidth / 2f
        anchorY = viewportHeight / 2f
        transition(OP_ADVANCE_STOP, imageWidth, imageHeight, viewportWidth, viewportHeight)
    }

    /** Re-resolves against a new viewport: fill keeps covering it and the pan stays legal. */
    fun reclamp(imageWidth: Int, imageHeight: Int, viewportWidth: Float, viewportHeight: Float) {
        if (isZoomed) transition(OP_RECLAMP, imageWidth, imageHeight, viewportWidth, viewportHeight)
    }

    /**
     * The initial gesture can arrive while a cloud original's dimensions are loading: a free zoom
     * keeps its size on screen, 100% stays 1:1, and the last gesture's focal point stays put.
     */
    fun adoptNativeDimensions(oldWidth: Int, oldHeight: Int, width: Int, height: Int,
        viewportWidth: Float, viewportHeight: Float) {
        transition(OP_ADOPT_IMAGE, width, height, viewportWidth, viewportHeight, oldWidth.toDouble(),
            oldHeight.toDouble(), anchorX.toDouble(), anchorY.toDouble())
    }

    private fun transition(
        op: Int,
        imageWidth: Int,
        imageHeight: Int,
        viewportWidth: Float,
        viewportHeight: Float,
        a: Double = 0.0,
        b: Double = 0.0,
        c: Double = 0.0,
        d: Double = 0.0,
    ): Int {
        val result = NativeBridge.canvasZoom(model, op, a, b, c, d, viewportWidth.toDouble(),
            viewportHeight.toDouble(), imageWidth.toDouble(), imageHeight.toDouble())
        publish()
        return result
    }

    private fun query(
        which: Int,
        imageWidth: Int,
        imageHeight: Int,
        viewportWidth: Float,
        viewportHeight: Float,
    ): Double =
        NativeBridge.canvasZoomQuery(model, which, viewportWidth.toDouble(),
            viewportHeight.toDouble(), imageWidth.toDouble(), imageHeight.toDouble())

    private fun publish() {
        pixelScale = model[0].toFloat()
        panX = model[1].toFloat()
        panY = model[2].toFloat()
    }

    companion object {
        const val PINCH_COOLDOWN_MS = 300L
        const val DOUBLE_TAP_TIMEOUT_MS = 280L
        const val DOUBLE_TAP_SLOP_PX = 48f
        const val SWIPE_PAGE_THRESHOLD_PX = 96f

        // Mirrors of `src/android/native/src/canvas_zoom.rs`.
        private const val STATE_LEN = 17
        private const val OP_PINCH_CHANGED = 0
        private const val OP_PINCH_ENDED = 1
        private const val OP_DRAG_CHANGED = 2
        private const val OP_DRAG_ENDED = 3
        private const val OP_REBASE_DRAG = 4
        private const val OP_DOUBLE_TAP = 5
        private const val OP_ADVANCE_STOP = 6
        private const val OP_RECLAMP = 7
        private const val OP_ADOPT_IMAGE = 8
        private const val QUERY_EFFECTIVE_SCALE = 0
        private const val QUERY_FIT_SCALE = 1
        private const val QUERY_NEXT_STOP = 2
        private const val STOP_FILL = 1
        private const val STOP_ACTUAL_SIZE = 2
    }
}

@Composable
fun rememberCanvasZoomState(): CanvasZoomState = remember { CanvasZoomState() }

@Composable
internal fun CanvasZoomBadge(
    label: String,
    isZoomed: Boolean,
    actionDescription: String,
    enabled: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Box(
        modifier
            .defaultMinSize(minWidth = 44.dp, minHeight = 44.dp)
            .clickable(enabled = enabled, role = Role.Button, onClick = onClick)
            .padding(8.dp)
            .semantics {
                contentDescription = actionDescription
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
        var pinching = false
        var pinchMagnification = 1f
        var gestureWasMultiTouch = false
        var dragX = 0f
        var dragY = 0f
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
                if (!pinching) {
                    zoomState.dragEnded()
                    pinching = true
                    pinchMagnification = 1f
                }
                gestureWasMultiTouch = true
                val zoomChange = event.calculateZoom()
                if (zoomChange.isFinite() && zoomChange > 0f) pinchMagnification *= zoomChange
                // Compose's calculateCentroid() skips pointers pressed this frame, which
                // would capture the pinch's start centroid at the first finger alone.
                val centroidX = pressed.sumOf { it.position.x.toDouble() }.toFloat() / pressed.size
                val centroidY = pressed.sumOf { it.position.y.toDouble() }.toFloat() / pressed.size
                zoomState.pinchChanged(
                    magnification = pinchMagnification,
                    centroidX = centroidX,
                    centroidY = centroidY,
                    imageWidth = imgW,
                    imageHeight = imgH,
                    viewportWidth = viewportW,
                    viewportHeight = viewportH,
                )
                event.changes.forEach { if (it.positionChanged()) it.consume() }
            } else if (pressed.size == 1 && !consumedByChild) {
                if (pinching) {
                    pinching = false
                    zoomState.pinchEnded(pinchMagnification, clockMs(), imgW, imgH, viewportW, viewportH)
                    dragX = 0f
                    dragY = 0f
                }
                val panChange = event.calculatePan()
                maxMovement = max(maxMovement, (pressed.first().position - downPos).getDistance())
                if (panChange != Offset.Zero) {
                    if (zoomState.isZoomed) {
                        dragX += panChange.x
                        dragY += panChange.y
                        val panned =
                            zoomState.dragChanged(
                                translationX = dragX,
                                translationY = dragY,
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
        if (pinching) {
            val (imgW, imgH) = imageDimensions()
            zoomState.pinchEnded(pinchMagnification, upTimeMs, imgW, imgH,
                size.width.toFloat().coerceAtLeast(1f), size.height.toFloat().coerceAtLeast(1f))
        }
        zoomState.dragEnded()
        if (gestureWasMultiTouch) {
            lastTapTimeMs = -1L
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
