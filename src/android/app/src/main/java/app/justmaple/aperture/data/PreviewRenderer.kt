package app.justmaple.aperture.data

import android.view.Surface
import java.io.Closeable

/** What the view model asks of the editor preview; EditorRenderer is the JNI implementation. */
interface PreviewRenderer : Closeable {
    val hasPresented: Boolean
    val revision: Int

    fun invalidateDraws(): Int

    /** The next draw must reload the model from its XML even if the string is unchanged (#4766). */
    fun invalidateModel()

    suspend fun open(path: String, document: String, edge: Int, generation: Int): Map<String, Float>

    /** Loads [document] into the open photo's model and returns its slider values, as [open] does. */
    suspend fun modelValues(document: String): Map<String, Float>

    suspend fun autoWhiteBalance(document: String): app.justmaple.aperture.WhiteBalanceRecommendation

    suspend fun nativeDimensions(photo: Photo): NativeImageSize?
    suspend fun nativeDetail(request: NativeDetailRequest): android.graphics.Bitmap
    fun cancelNativeDetail()

    /**
     * Receives each adoption of a session's name-only imported Auto pair (#4669) off the main
     * thread: the slider values the renderer now draws for [generation], or the failure of its one
     * re-render. A renderer that never resolves imported Auto has nothing to report.
     */
    fun observeImportedWhiteBalance(
        listener: (generation: Int, values: Result<Map<String, Float>>) -> Unit
    ) {}

    fun presentationSize(size: NativeImageSize, crop: app.justmaple.aperture.ui.CropRect): NativeImageSize =
        NativeImageSize.unpack(NativeBridge.presentationDimensions(size.width, size.height,
            crop.top, crop.left, crop.bottom, crop.right, crop.angle))

    /** raw-core's reading of the mask containers [input] describes (`XmpDocument.maskInput`). */
    fun readMasks(input: String): String = NativeBridge.masksRead(input)

    /** raw-core's canonical containers for [input]'s edited `layers`. */
    fun writeMasks(input: String): String = NativeBridge.masksWrite(input)

    /** The layer's weight over the full frame from raw-core's evaluator, `0…255` per cell. */
    fun maskWeights(layer: String, width: Int, height: Int): ByteArray = NativeBridge.maskWeights(layer, width, height)

    /**
     * The row-major projective `[m0 … m8]` from the presented image (the [crop] and the
     * seven manual-geometry sliders in `geometryFieldNames` order) onto the full frame masks live in.
     */
    fun maskFrame(size: NativeImageSize, crop: app.justmaple.aperture.ui.CropRect, geometry: List<Float>): DoubleArray =
        NativeBridge.maskFrame(size.width, size.height, crop.top, crop.left, crop.bottom, crop.right, crop.angle,
            geometry.toFloatArray())

    /** The colour-range seed (or refusal) at a full-frame point of the open RAW under [document]. */
    suspend fun sampleMaskRange(document: String, x: Float, y: Float): String

    fun recordSurface(
        next: Surface?,
        w: Int,
        h: Int,
        wideColor: Boolean = false,
    ): EditorRenderer.SurfaceBinding

    suspend fun attach(binding: EditorRenderer.SurfaceBinding)

    suspend fun draw(next: Map<String, Float>, expectedRevision: Int, xml: String)

    suspend fun refine(expectedRevision: Int)

    suspend fun shutdown()
}
