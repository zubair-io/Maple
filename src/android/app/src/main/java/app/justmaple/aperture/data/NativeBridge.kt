package app.justmaple.aperture.data

import android.graphics.Bitmap
import android.view.Surface

object NativeBridge {
    init {
        System.loadLibrary("maple_jni")
    }

    external fun createRenderer(): Long

    external fun closeRenderer(renderer: Long)

    external fun open(path: String, xml: String, edge: Int, renderer: Long): Long

    external fun close(handle: Long)

    external fun values(handle: Long): String

    external fun parametricCurve(xml: String): String

    /** Points the shared crop overlay surface extends past the viewport on every side (#5715). */
    external fun cropOverlayOverscan(): Double

    /** Rasterizes the shared crop overlay into an RGBA_8888 [bitmap]; see `crop_overlay.rs`. */
    external fun cropOverlay(bitmap: Bitmap, params: DoubleArray, active: Int)

    external fun cropHandleCenters(params: DoubleArray): DoubleArray

    /** Outputs at `x = i / samples` for interleaved `[x, y]` knots, from raw-core's evaluator. */
    external fun pointCurve(knots: FloatArray, samples: Int): FloatArray

    external fun openNativeDetail(path: String): Long
    external fun copyNativeDetail(handle: Long): Long
    external fun closeNativeDetail(source: Long)
    external fun outputPrimaries(handle: Long): Int
    external fun platformNativeDetailFits(width: Int, height: Int, sourceBytes: Long): Boolean
    external fun nativeDimensions(path: String, extension: String): Long
    external fun presentationDimensions(width: Int, height: Int, top: Float, left: Float,
        bottom: Float, right: Float, angle: Float): Long

    /** Applies a shared canvas zoom transition to [state] in place; see `canvas_zoom.rs`. */
    external fun canvasZoom(state: DoubleArray, op: Int, a: Double, b: Double, c: Double,
        d: Double, viewportWidth: Double, viewportHeight: Double, imageWidth: Double,
        imageHeight: Double): Int

    external fun canvasZoomQuery(state: DoubleArray, query: Int, viewportWidth: Double,
        viewportHeight: Double, imageWidth: Double, imageHeight: Double): Double
    external fun renderNativeDetail(source: Long, xml: String, x: Int, y: Int, width: Int,
        height: Int, target: Int, flag: Long): Bitmap

    external fun scopePixels(pixels: IntArray, width: Int, height: Int): String

    external fun createAutoWhiteBalance(handle: Long, xml: String): Long
    external fun runAutoWhiteBalance(work: Long): String
    external fun closeAutoWhiteBalance(work: Long)
    external fun createImportedAutoWhiteBalance(handle: Long): Long
    external fun runImportedAutoWhiteBalance(work: Long, cancellation: Long): Boolean
    external fun adoptImportedAutoWhiteBalance(handle: Long, work: Long)
    external fun closeImportedAutoWhiteBalance(work: Long)

    /** `{"layers": [...]}` of the mask containers described by [input] (see `mask_document.rs`). */
    external fun masksRead(input: String): String

    /** Replacement mask containers for [input]'s containers and layers (see `mask_write.rs`). */
    external fun masksWrite(input: String): String

    /** `width × height` weights (`0…255`) of a JSON layer's mask over the full frame. */
    external fun maskWeights(layer: String, width: Int, height: Int): ByteArray

    /**
     * Row-major projective `[m0 … m8]` taking a point on the presented image (crop, then the
     * seven manual-geometry sliders in [geometry]) to the full frame masks live in.
     */
    external fun maskFrame(width: Int, height: Int, top: Float, left: Float, bottom: Float,
        right: Float, angle: Float, geometry: FloatArray): DoubleArray

    external fun createMaskRange(handle: Long, xml: String): Long
    external fun runMaskRange(work: Long, x: Float, y: Float): String
    external fun closeMaskRange(work: Long)

    external fun setField(handle: Long, index: Int, value: Float)

    external fun setModel(handle: Long, xml: String)

    external fun rasterCompatible(xml: String): Boolean

    external fun attach(
        handle: Long,
        surface: Surface?,
        width: Int,
        height: Int,
        wideColor: Boolean,
    )

    external fun createCancellation(): Long

    external fun setCancellation(flag: Long, value: Boolean)

    external fun closeCancellation(flag: Long)

    external fun render(handle: Long, flag: Long): Boolean

    external fun createPreparation(handle: Long): Long

    external fun runPreparation(work: Long, flag: Long): Boolean

    external fun applyPreparation(handle: Long, work: Long, flag: Long): Boolean

    external fun closePreparation(work: Long)

    external fun thumbnail(path: String, destination: String, xml: String, edge: Int)

    external fun sharedDerivative(path: String, destination: String, xml: String, preview: Boolean)

    external fun cacheValid(fd: Int, edge: Int, format: String): Boolean

    external fun cachePng(fd: Int, destination: String)

    external fun export(path: String, xml: String, destination: String)

    external fun exportConfigured(path: String, xml: String, destination: String,
        format: String, quality: Int, maxEdge: Int, displayP3: Boolean)

    external fun stageBitmap(bitmap: Bitmap, destination: String, profile: FloatArray)
}
