package app.justmaple.aperture

import android.net.Uri
import android.view.Surface
import app.justmaple.aperture.data.*
import app.justmaple.aperture.ui.*
import java.io.File
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class CropPresentationTest {
    private class Renderer : PreviewRenderer {
        override val hasPresented = true
        override var revision = 0
        val frames = mutableListOf<XmpDocument>()
        override fun invalidateDraws() = ++revision
        override fun invalidateModel() {}
        override suspend fun open(path: String, document: String, edge: Int, generation: Int) =
            mapOf("exposure" to 1f, "_raw" to 1f, "_uncropped_aspect" to 1.5f, "_aspect" to 1f)
        override suspend fun autoWhiteBalance(document: String): WhiteBalanceRecommendation = error("Not expected")
        override fun recordSurface(next: Surface?, w: Int, h: Int, wideColor: Boolean) =
            EditorRenderer.SurfaceBinding(next, w, h, wideColor)
        override suspend fun attach(binding: EditorRenderer.SurfaceBinding) {}
        override suspend fun draw(next: Map<String, Float>, expectedRevision: Int, xml: String) {
            frames += XmpDocument(xml)
        }
        override suspend fun refine(expectedRevision: Int) {}
        override suspend fun shutdown() {}
        override fun close() {}
    }

    @Test
    fun cropHandlesSeeTheWholeImageWhileSavesUndoAndExitKeepTheRealCrop() = runBlocking {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        val app = RuntimeEnvironment.getApplication()
        val input = File.createTempFile("crop-preview-", ".dng", app.cacheDir).apply { writeText("renderer seam") }
        val photo = Photo(Uri.fromFile(input), input.name, input.length(), input.lastModified(), null)
        val library = PhotoLibrary(app)
        val renderer = Renderer()
        val model = MapleViewModel(app, library, renderer)
        val original = XmpDocument().withAttribute("crs:HasCrop", "True")
            .withAttribute("crs:CropLeft", "0.2").withAttribute("crs:CropRight", "0.8")
            .withAttribute("crs:CropAngle", "3.5").withAttribute("xmp:Label", "retain")
        library.save(photo, original, null)
        try {
            model.open(photo)
            withTimeout(10_000) { model.state.first { it.documentLoaded && !it.loading } }
            model.edit()
            withTimeout(10_000) { model.state.first { it.values.isNotEmpty() } }
            model.setCropToolActive(true)
            assertTrue(renderer.frames.last().cropRect().isIdentityRect)
            assertEquals(3.5f, renderer.frames.last().cropRect().angle, 0f)
            model.applyCropRect(CropRect(0.1f, 0.25f, 0.9f, 0.75f, 2f))
            assertTrue(renderer.frames.last().cropRect().isIdentityRect)
            assertEquals(2f, renderer.frames.last().cropRect().angle, 0f)
            assertTrue(model.flush())
            val saved = library.loadSidecar(photo).document
            assertEquals(0.25f, saved.cropRect().left, 0f)
            assertEquals("retain", saved.attribute("xmp:Label"))
            model.undo()
            assertEquals(0.2f, model.state.value.document.cropRect().left, 0f)
            assertTrue(renderer.frames.last().cropRect().isIdentityRect)
            model.setCropToolActive(false)
            assertEquals(0.2f, renderer.frames.last().cropRect().left, 0f)
            assertEquals(3.5f, renderer.frames.last().cropRect().angle, 0f)
            assertTrue(model.flush())
            assertEquals(original.serialize(), library.loadSidecar(photo).document.serialize())
            model.back()
        } finally {
            input.delete()
            Dispatchers.resetMain()
        }
    }
}
