package app.justmaple.aperture.ui

import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.calculatePan
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.PointerInputScope
import androidx.compose.ui.input.pointer.positionChanged
import kotlin.math.abs
import kotlin.math.max

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
        imageDimensions().let { (imgW, imgH) ->
            zoomState.settle(imgW, imgH, size.width.toFloat().coerceAtLeast(1f),
                size.height.toFloat().coerceAtLeast(1f))
        }
        var consumedByChild = down.isConsumed
        val downTimeMs = clockMs()
        val downPos = down.position
        var pinch: PinchTracker? = null
        var pinchResets = zoomState.resets
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
                if (pinchResets != zoomState.resets) pinch = null
                val tracker =
                    pinch?.also { tracker ->
                        val fingers =
                            event.changes.map {
                                PinchFinger(
                                    previous = if (it.previousPressed) it.previousPosition else null,
                                    current = if (it.pressed) it.position else null,
                                )
                            }
                        tracker.advance(fingers)?.let { regrouped ->
                            zoomState.rebasePinch(regrouped.x, regrouped.y, imgW, imgH, viewportW, viewportH)
                        }
                    } ?: PinchTracker(pressed.map { it.position }).also {
                        zoomState.dragEnded()
                        pinch = it
                        pinchResets = zoomState.resets
                    }
                gestureWasMultiTouch = true
                zoomState.pinchChanged(
                    magnification = tracker.magnification,
                    centroidX = tracker.centroid.x,
                    centroidY = tracker.centroid.y,
                    imageWidth = imgW,
                    imageHeight = imgH,
                    viewportWidth = viewportW,
                    viewportHeight = viewportH,
                )
                event.changes.forEach { if (it.positionChanged()) it.consume() }
            } else if (pressed.size == 1 && !consumedByChild) {
                pinch?.let {
                    pinch = null
                    zoomState.pinchEnded(it.magnification, clockMs(), imgW, imgH, viewportW, viewportH)
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
        pinch?.let {
            val (imgW, imgH) = imageDimensions()
            zoomState.pinchEnded(it.magnification, upTimeMs, imgW, imgH,
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
