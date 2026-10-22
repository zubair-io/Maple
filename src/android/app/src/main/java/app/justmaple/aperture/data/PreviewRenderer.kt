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

    suspend fun autoWhiteBalance(document: String): app.justmaple.aperture.WhiteBalanceRecommendation

    suspend fun nativeDimensions(photo: Photo): NativeImageSize?
    suspend fun nativeDetail(request: NativeDetailRequest): android.graphics.Bitmap
    fun cancelNativeDetail()

    fun presentationSize(size: NativeImageSize, crop: app.justmaple.aperture.ui.CropRect): NativeImageSize =
        NativeImageSize.unpack(NativeBridge.presentationDimensions(size.width, size.height,
            crop.top, crop.left, crop.bottom, crop.right, crop.angle))

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
