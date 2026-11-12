package app.justmaple.aperture

import android.net.Uri
import android.view.Surface
import androidx.test.platform.app.InstrumentationRegistry
import app.justmaple.aperture.data.EditorRenderer
import app.justmaple.aperture.data.LinearMask
import app.justmaple.aperture.data.MaskCombine
import app.justmaple.aperture.data.MaskGroup
import app.justmaple.aperture.data.NativeDetailRequest
import app.justmaple.aperture.data.NativeImageSize
import app.justmaple.aperture.data.Photo
import app.justmaple.aperture.data.PhotoLibrary
import app.justmaple.aperture.data.PreviewRenderer
import app.justmaple.aperture.data.RadialMask
import java.io.File
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.*
import org.junit.Test

/**
 * The editor's mask commands through raw-core's real sidecar codec on device:
 * `PreviewRenderer`'s JNI `readMasks`/`writeMasks`, `XmpDocument`'s splice, the
 * ViewModel's history and the `.xmp` the library writes and reads back. Only the
 * pixel side (open, draw) is stubbed: no RAW is decoded.
 */
class MaskEditorCodecTest {
    private val app = InstrumentationRegistry.getInstrumentation().targetContext.applicationContext as android.app.Application
    private val raw = File.createTempFile("mask-codec", ".dng", app.cacheDir).apply { writeText("renderer seam") }
    private val photo = Photo(Uri.fromFile(raw), raw.name, raw.length(), raw.lastModified(), null)
    private val library = PhotoLibrary(app)

    private object PixelStub : PreviewRenderer {
        override val hasPresented = true
        override var revision = 0
        override fun invalidateDraws() = ++revision
        override fun invalidateModel() {}
        override suspend fun open(path: String, document: String, edge: Int, generation: Int) =
            mapOf("exposure" to 0f, "_raw" to 1f, "_uncropped_aspect" to 1.5f)
        override suspend fun modelValues(document: String): Map<String, Float> = error("Not exercised")
        override suspend fun autoWhiteBalance(document: String): WhiteBalanceRecommendation = error("Not exercised")
        override suspend fun nativeDimensions(photo: Photo): NativeImageSize? = null
        override suspend fun nativeDetail(request: NativeDetailRequest): android.graphics.Bitmap = error("Not exercised")
        override fun cancelNativeDetail() {}
        override fun recordSurface(next: Surface?, w: Int, h: Int, wideColor: Boolean) =
            EditorRenderer.SurfaceBinding(next, w, h, wideColor)
        override suspend fun attach(binding: EditorRenderer.SurfaceBinding) {}
        override suspend fun draw(next: Map<String, Float>, expectedRevision: Int, xml: String) {}
        override suspend fun refine(expectedRevision: Int) {}
        override suspend fun sampleMaskRange(document: String, x: Float, y: Float): String = error("Not exercised")
        override suspend fun shutdown() {}
        override fun close() {}
    }

    private val model = MapleViewModel(app, library, PixelStub)

    private fun onMain(block: () -> Unit) = InstrumentationRegistry.getInstrumentation().runOnMainSync(block)

    @After
    fun tearDown() {
        raw.delete()
    }

    @Test
    fun maskCommandsWriteRawCoreSidecarsThatReadBackFromDisk() {
        runBlocking {
            onMain { model.open(photo) }
            withTimeout(30_000) { model.state.first { it.documentLoaded && !it.loading } }
            onMain { model.edit() }
            withTimeout(30_000) { model.state.first { it.canEdit } }
        }
        onMain {
            model.addMaskLayer(radial = false)
            model.addMaskLayer(radial = true)
            model.setMaskAdjustment("exposure", 0.5f)
        }
        val split = model.state.value.document.serialize()
        assertTrue(split, split.contains("crs:GradientBasedCorrections"))
        assertTrue(split, split.contains("crs:CircularGradientBasedCorrections"))

        // The linear becomes a group: raw-core's writer moves it into the group
        // container after the radial and keys the stack so it stays first.
        onMain {
            model.selectMaskLayer(0)
            model.addMaskComponent(radial = true, combine = MaskCombine.Subtract)
        }
        val layers = model.maskLayers()
        assertEquals(2, layers.size)
        val group = layers[0].shape as MaskGroup
        assertTrue(group.components[0].shape is LinearMask)
        assertEquals("The linear keeps its source leaf", 0, group.components[0].source)
        assertTrue(layers[1].shape is RadialMask)
        val grouped = model.state.value.document.serialize()
        assertTrue(grouped, grouped.contains("crs:MaskGroupBasedCorrections"))
        assertFalse(grouped, grouped.contains("crs:GradientBasedCorrections"))
        assertTrue(grouped, grouped.contains("papp:LayerOrder"))

        onMain { model.removeMaskLayer(1) }
        assertTrue(runBlocking { model.flush() })
        val saved = runBlocking { library.loadSidecar(photo) }.document
        val reread = model.maskLayers(saved)
        assertEquals(model.maskLayers(), reread)
        assertTrue(reread.single().shape is MaskGroup)
        assertFalse(saved.original, saved.original.contains("crs:CircularGradientBasedCorrections"))
    }
}
