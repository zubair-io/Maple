package app.justmaple.aperture.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.saveable.Saver
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import app.justmaple.aperture.PhotoMode
import app.justmaple.aperture.data.NativeBridge
import app.justmaple.aperture.data.NativeImageSize

/** The shared zoom model's two entry points, so the Compose state can be exercised on the JVM. */
internal interface CanvasZoomNative {
    fun transition(state: DoubleArray, op: Int, a: Double, b: Double, c: Double, d: Double,
        viewportWidth: Double, viewportHeight: Double, imageWidth: Double, imageHeight: Double): Int

    fun query(state: DoubleArray, which: Int, viewportWidth: Double, viewportHeight: Double,
        imageWidth: Double, imageHeight: Double): Double
}

internal object JniCanvasZoom : CanvasZoomNative {
    override fun transition(state: DoubleArray, op: Int, a: Double, b: Double, c: Double,
        d: Double, viewportWidth: Double, viewportHeight: Double, imageWidth: Double,
        imageHeight: Double): Int =
        NativeBridge.canvasZoom(state, op, a, b, c, d, viewportWidth, viewportHeight, imageWidth,
            imageHeight)

    override fun query(state: DoubleArray, which: Int, viewportWidth: Double,
        viewportHeight: Double, imageWidth: Double, imageHeight: Double): Double =
        NativeBridge.canvasZoomQuery(state, which, viewportWidth, viewportHeight, imageWidth,
            imageHeight)
}

/**
 * What a zoom belongs to (#5748). Opening another photo, switching Preview and Edit or entering
 * the crop tool returns to fit; a rotation or a fold posture that places the canvas elsewhere does
 * not.
 */
internal data class CanvasZoomScope(val photoKey: String?, val mode: PhotoMode, val cropTool: Boolean)

/** The original's extent the zoom is expressed in, and the crop it is presented under. */
internal data class CanvasZoomFrame(
    val photoKey: String?,
    val width: Int,
    val height: Int,
    val crop: CropRect,
)

/**
 * Where an image presented under [next] lies in this frame's pixels, as `[x, y, width, height]`.
 * Crop edges are fractions of the uncropped frame, so its pixel size follows from this frame's
 * extent and crop; NaN when this crop is too thin to measure, which the model treats as a plain
 * reclamp.
 */
internal fun CanvasZoomFrame.extentOf(next: CropRect): DoubleArray {
    val spanX = crop.right.toDouble() - crop.left
    val spanY = crop.bottom.toDouble() - crop.top
    if (spanX < MIN_CROP_SPAN || spanY < MIN_CROP_SPAN) return DoubleArray(4) { Double.NaN }
    val unitX = width / spanX
    val unitY = height / spanY
    return doubleArrayOf(
        (next.left.toDouble() - crop.left) * unitX,
        (next.top.toDouble() - crop.top) * unitY,
        (next.right.toDouble() - next.left) * unitX,
        (next.bottom.toDouble() - next.top) * unitY,
    )
}

private const val MIN_CROP_SPAN = 1e-4

/** Saves the zoom with the activity, so a rotation or split screen keeps it. */
internal fun canvasZoomSaver(native: CanvasZoomNative = JniCanvasZoom): Saver<CanvasZoomState, Any> =
    listSaver(
        save = { zoom ->
            val scope = zoom.scope
            val frame = zoom.frameFor(zoom.scope?.photoKey)
            listOf(
                zoom.slots(),
                floatArrayOf(zoom.anchor.first, zoom.anchor.second),
                scope?.photoKey,
                scope?.mode?.name,
                scope?.cropTool,
                frame?.let { intArrayOf(it.width, it.height) },
                frame?.crop?.let { floatArrayOf(it.top, it.left, it.bottom, it.right, it.angle) },
            )
        },
        restore = { saved ->
            val anchor = saved[1] as FloatArray
            val scope = (saved[3] as String?)?.let {
                CanvasZoomScope(saved[2] as String?, PhotoMode.valueOf(it), saved[4] as Boolean)
            }
            val extent = saved[5] as IntArray?
            val crop = saved[6] as FloatArray?
            val frame = if (scope != null && extent != null && crop != null)
                CanvasZoomFrame(scope.photoKey, extent[0], extent[1],
                    CropRect(crop[0], crop[1], crop[2], crop[3], crop[4]))
            else null
            CanvasZoomState(native).apply {
                restore(saved[0] as DoubleArray, anchor[0], anchor[1], scope, frame)
            }
        },
    )

@Composable
fun rememberCanvasZoomState(): CanvasZoomState = rememberCanvasZoomState(JniCanvasZoom)

@Composable
internal fun rememberCanvasZoomState(native: CanvasZoomNative): CanvasZoomState =
    rememberSaveable(saver = canvasZoomSaver(native)) { CanvasZoomState(native) }

/**
 * Carries the zoom for a canvas showing [scope] in a [viewportWidth] × [viewportHeight] viewport:
 * the original's size replaces [placeholder] when it lands, a crop change reframes the zoom, and
 * a viewport change re-clamps it. A canvas instance composed elsewhere for the same scope (a fold
 * posture) continues the zoom instead of starting from fit.
 */
@Composable
internal fun CanvasZoomContinuity(
    zoomState: CanvasZoomState,
    scope: CanvasZoomScope,
    nativeImageSize: NativeImageSize?,
    presentedCrop: CropRect,
    placeholder: Pair<Int, Int>,
    viewportWidth: Float,
    viewportHeight: Float,
) {
    LaunchedEffect(scope) { zoomState.enterScope(scope) }
    LaunchedEffect(nativeImageSize, scope.photoKey, presentedCrop) {
        val size = nativeImageSize ?: return@LaunchedEffect
        zoomState.adoptImage(scope.photoKey, size, presentedCrop, placeholder.first,
            placeholder.second, viewportWidth, viewportHeight)
    }
    val imageDims = zoomState.frameFor(scope.photoKey)?.let { it.width to it.height } ?: placeholder
    LaunchedEffect(viewportWidth, viewportHeight, imageDims) {
        zoomState.reclamp(imageDims.first, imageDims.second, viewportWidth, viewportHeight)
    }
}
