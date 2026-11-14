package app.justmaple.aperture.ui

import android.graphics.Bitmap
import android.graphics.Matrix
import android.graphics.Paint
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.waitForUpOrCancellation
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.clipRect
import androidx.compose.ui.graphics.drawscope.drawIntoCanvas
import androidx.compose.ui.graphics.nativeCanvas
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.input.pointer.PointerInputChange
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import app.justmaple.aperture.MapleState
import app.justmaple.aperture.MapleViewModel
import app.justmaple.aperture.data.LinearMask
import app.justmaple.aperture.data.MaskGroup
import app.justmaple.aperture.data.MaskLayer
import app.justmaple.aperture.data.MaskPoint
import app.justmaple.aperture.data.MaskShape
import app.justmaple.aperture.data.NativeImageSize
import app.justmaple.aperture.data.RadialMask
import app.justmaple.aperture.data.toJson
import app.justmaple.aperture.editedShape
import app.justmaple.aperture.maskLayers
import app.justmaple.aperture.sampleMaskRangeAt
import app.justmaple.aperture.selectedMask
import app.justmaple.aperture.setMaskShape
import kotlin.math.max
import kotlin.math.roundToInt
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Tint peak opacity at `w = 1`, linear in `w` (`mask-overlay.md`). */
private const val TINT_PEAK = .55f
/** The tint's sampling grid along the frame's long edge; raw-core caps it at 1024. */
private const val TINT_GRID = 192
/** Long edge of the frame the presented → frame map is built over; only its aspect matters. */
private const val FRAME_EDGE = 4096
private val GRAB_RADIUS = 14.dp
private val PIN_RADIUS = 7.dp

internal fun maskOverlayValue(shape: MaskShape?): String =
    when (shape) {
        null -> "No mask selected"
        is LinearMask -> "Linear gradient mask"
        is RadialMask -> if (shape.invert) "Inverted radial mask" else "Radial mask"
        is MaskGroup -> "Mask group"
    }

/** The full display frame masks are evaluated over, sized from the uncropped aspect. */
private fun maskFrameSize(aspect: Float): NativeImageSize =
    if (aspect >= 1f) NativeImageSize(FRAME_EDGE, (FRAME_EDGE / aspect).roundToInt().coerceAtLeast(2))
    else NativeImageSize((FRAME_EDGE * aspect).roundToInt().coerceAtLeast(2), FRAME_EDGE)

/** raw-core's weights for [layer] as a tint bitmap over the full frame, `TINT_PEAK` at `w = 1`. */
private fun tintBitmap(model: MapleViewModel, layer: MaskLayer, aspect: Float): Bitmap {
    val (w, h) =
        if (aspect >= 1f) TINT_GRID to (TINT_GRID / aspect).roundToInt().coerceIn(2, TINT_GRID)
        else (TINT_GRID * aspect).roundToInt().coerceIn(2, TINT_GRID) to TINT_GRID
    val weights = model.renderer.maskWeights(layer.toJson().toString(), w, h)
    val rgb = MapleColors.primary.toArgb() and 0xFFFFFF
    val pixels = IntArray(w * h) { i -> ((weights[i].toInt() and 0xFF) * TINT_PEAK).roundToInt() shl 24 or rgb }
    return Bitmap.createBitmap(pixels, w, h, Bitmap.Config.ARGB_8888)
}

/**
 * The seven manual-geometry sliders the canvas presents, in `geometryFieldNames` order;
 * a slider the photo never set reads its default, as raw-core's model does.
 */
internal fun MapleState.presentedGeometry(): List<Float> =
    geometryFields.map { values[it.name] ?: it.initial }

/**
 * The selected layer's handles and weight tint over the canvas (`mask-overlay.md`).
 * It fills the presented image box, so canvas zoom reaches it through the parent's
 * graphics layer; [zoom] counter-scales the pins and grab radius so they keep their
 * on-screen size. Points cross one projective map (the crop, then the manual geometry,
 * as the render samples) onto the full frame masks live in: handles, tint and the
 * eyedropper's sample point all go through it or its inverse.
 * A handle press consumes its down, so the canvas zoom gesture yields to the drag;
 * while the colour-range eyedropper is armed every tap samples instead.
 */
@Composable
internal fun MaskOverlay(model: MapleViewModel, state: MapleState, zoom: Float, modifier: Modifier = Modifier) {
    val layers = remember(state.document) { runCatching { model.maskLayers(state.document) }.getOrDefault(emptyList()) }
    val layer = state.selectedMask(layers)
    val shape = layer?.let(state::editedShape)
    val aspect = state.uncroppedAspect()
    val crop = remember(state.document, state.cropToolActive) { state.presentedCropRect() }
    val geometry = state.presentedGeometry()
    val toFrame =
        remember(crop, aspect, geometry) {
            runCatching { MaskProjection(model.renderer.maskFrame(maskFrameSize(aspect), crop, geometry)) }.getOrNull()
        }
    val fromFrame = remember(toFrame) { toFrame?.inverse() }
    val tint by
        produceState<Bitmap?>(null, layer, aspect) {
            value = layer?.let { selected ->
                runCatching { withContext(Dispatchers.Default) { tintBitmap(model, selected, aspect) } }.getOrNull()
            }
        }
    val density = LocalDensity.current
    val scale = zoom.coerceAtLeast(.01f)
    val grab = with(density) { GRAB_RADIUS.toPx() } / scale
    val currentShape by rememberUpdatedState(shape)
    val currentPicking by rememberUpdatedState(state.maskPicking && layer != null)
    val currentToFrame by rememberUpdatedState(toFrame)
    val currentFromFrame by rememberUpdatedState(fromFrame)
    val currentGrab by rememberUpdatedState(grab)
    BoxWithConstraints(
        modifier
            .fillMaxSize()
            .testTag("editor-mask-overlay")
            .semantics {
                contentDescription = "Mask overlay"
                stateDescription = maskOverlayValue(shape)
            }
            .pointerInput(model) {
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    val w = size.width.toFloat().coerceAtLeast(1f)
                    val h = size.height.toFloat().coerceAtLeast(1f)
                    val forward = currentToFrame ?: return@awaitEachGesture
                    val back = currentFromFrame ?: return@awaitEachGesture
                    fun frameAt(position: Offset) = forward.apply(MaskPoint(position.x / w, position.y / h))
                    if (currentPicking) {
                        down.consume()
                        val up = waitForUpOrCancellation() ?: return@awaitEachGesture
                        up.consume()
                        val at = frameAt(up.position)
                        // A keystone can put a presented corner past the frame's horizon.
                        if (at.x.isFinite() && at.y.isFinite()) model.sampleMaskRangeAt(at.x, at.y)
                        return@awaitEachGesture
                    }
                    val start = currentShape ?: return@awaitEachGesture
                    val anchor = frameAt(down.position)
                    val handle =
                        hitMaskHandle(start, anchor, currentGrab) { back.apply(it).let { p -> MaskPoint(p.x * w, p.y * h) } }
                            ?: return@awaitEachGesture
                    down.consume()
                    var moved = false
                    try {
                        while (true) {
                            val event = awaitPointerEvent()
                            val change: PointerInputChange = event.changes.firstOrNull { it.id == down.id } ?: break
                            if (!change.pressed) {
                                change.consume()
                                break
                            }
                            if (change.positionChanged()) {
                                change.consume()
                                moved = true
                                model.setMaskShape(dragMaskHandle(start, handle, frameAt(change.position), anchor))
                            }
                        }
                    } finally {
                        if (moved) model.commitGesture()
                    }
                }
            }
    ) {
        val back = fromFrame
        // Decorative: the tint and strokes carry no semantics; the handles below do.
        Canvas(Modifier.fillMaxSize()) {
            if (back == null) return@Canvas
            clipRect { tint?.let { drawTint(it, back) } }
            shape?.let { drawMaskShape(it, back, scale) }
        }
        if (shape != null && back != null) {
            val box = GRAB_RADIUS * 2 / scale
            for ((handle, point) in maskHandles(shape)) {
                val at = back.apply(point)
                Box(
                    Modifier.offset {
                            IntOffset(
                                (at.x * constraints.maxWidth - box.toPx() / 2).roundToInt(),
                                (at.y * constraints.maxHeight - box.toPx() / 2).roundToInt(),
                            )
                        }
                        .size(box)
                        .testTag("editor-mask-handle-${handle.id}")
                        .semantics { contentDescription = "Mask handle: ${handle.label}" }
                )
            }
        }
    }
}

/** The tint bitmap's cell centres sit on `i / (w − 1)` of the frame, as raw-core samples it. */
private fun DrawScope.drawTint(bitmap: Bitmap, back: MaskProjection) {
    val matrix =
        Matrix().apply {
            setTranslate(-.5f, -.5f)
            postScale(1f / (bitmap.width - 1), 1f / (bitmap.height - 1))
            postConcat(Matrix().apply { setValues(back.values.map(Double::toFloat).toFloatArray()) })
            postScale(size.width, size.height)
        }
    drawIntoCanvas { it.nativeCanvas.drawBitmap(bitmap, matrix, Paint(Paint.FILTER_BITMAP_FLAG)) }
}

private fun DrawScope.drawMaskShape(shape: MaskShape, back: MaskProjection, scale: Float) {
    fun px(point: MaskPoint) = back.apply(point).let { Offset(it.x * size.width, it.y * size.height) }
    val stroke = 1.5.dp.toPx() / scale
    val dash = PathEffect.dashPathEffect(floatArrayOf(6.dp.toPx() / scale, 4.dp.toPx() / scale))
    val outline = maskOutline(shape)
    if (outline.size >= 2) {
        val path = Path().apply {
            moveTo(px(outline.first()).x, px(outline.first()).y)
            outline.drop(1).map(::px).forEach { lineTo(it.x, it.y) }
        }
        drawPath(path, Color.White.copy(alpha = .9f), style = Stroke(stroke, pathEffect = dash))
    }
    val pin = PIN_RADIUS.toPx() / scale
    for ((handle, point) in maskHandles(shape)) {
        val at = px(point)
        val fill = if (handle == MaskHandle.RadialRotate) MapleColors.primary else Color.White.copy(alpha = .9f)
        drawCircle(fill, pin, at)
        drawCircle(Color.Black.copy(alpha = .5f), pin, at, style = Stroke(max(1f, stroke * .75f)))
    }
}
