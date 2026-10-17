package app.justmaple.aperture.data

import android.view.Surface
import java.io.Closeable

/** What the view model asks of the editor preview; EditorRenderer is the JNI implementation. */
interface PreviewRenderer : Closeable {
    val hasPresented: Boolean
    val revision: Int

    fun invalidateDraws(): Int

    suspend fun open(path: String, document: String, edge: Int, generation: Int): Map<String, Float>

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
