package app.justmaple.aperture

import android.net.Uri
import android.view.Surface
import app.justmaple.aperture.data.*
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
class OpeningComparisonTest {
    private class RecordingRenderer : PreviewRenderer {
        override val hasPresented = true
        override var revision = 0
        var latest: EditSnapshot? = null
        override fun invalidateDraws() = ++revision
        override fun invalidateModel() {}
        override suspend fun open(path: String, document: String, edge: Int, generation: Int) =
            mapOf("exposure" to (XmpDocument(document).attribute("crs:Exposure2012")?.toFloat() ?: 0f), "_raw" to 1f)
        override suspend fun autoWhiteBalance(document: String): app.justmaple.aperture.WhiteBalanceRecommendation = error("White balance analysis is not expected in this test")
        override fun recordSurface(next: Surface?, w: Int, h: Int, wideColor: Boolean) =
            EditorRenderer.SurfaceBinding(next, w, h, wideColor)
        override suspend fun attach(binding: EditorRenderer.SurfaceBinding) {}
        override suspend fun draw(next: Map<String, Float>, expectedRevision: Int, xml: String) {
            latest = EditSnapshot(next, XmpDocument(xml))
        }
        override suspend fun refine(expectedRevision: Int) {}
        override suspend fun shutdown() {}
        override fun close() {}
    }

    @Test
    fun beforeUsesOpeningEditsAndCurrentCropWithoutSavingTheComparison() = runBlocking {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        val app = RuntimeEnvironment.getApplication()
        val raw = File.createTempFile("comparison-", ".dng", app.cacheDir).apply { writeText("renderer seam") }
        val photo = Photo(Uri.fromFile(raw), raw.name, raw.length(), raw.lastModified(), null)
        val library = PhotoLibrary(app)
        val opening = XmpDocument().withAttribute("crs:Exposure2012", "1.25")
            .withAttribute("crs:HasCrop", "True").withAttribute("crs:CropLeft", "0.1")
            .withAttribute("xmp:Label", "opening metadata")
        library.save(photo, opening, null)
        val renderer = RecordingRenderer()
        val model = MapleViewModel(app, library, renderer)
        try {
            model.open(photo)
            withTimeout(10_000) { model.state.first { it.documentLoaded && !it.loading } }
            model.edit()
            withTimeout(10_000) { model.state.first { it.values.isNotEmpty() } }
            model.setField("exposure", 2f)
            model.commitGesture()
            model.attribute("crs:CropLeft", "0.25")
            model.setComparingBefore(true)
            withTimeout(10_000) { while (renderer.latest?.values?.get("exposure") != 1.25f) yield() }
            val before = renderer.latest!!
            assertEquals("0.25", before.document.attribute("crs:CropLeft"))
            assertEquals("1.25", before.document.attribute("crs:Exposure2012"))
            assertEquals("opening metadata", before.document.attribute("xmp:Label"))
            assertEquals("2", model.state.value.document.attribute("crs:Exposure2012"))
            assertTrue(model.flush())
            val persisted = library.loadSidecar(photo).document
            assertEquals("2", persisted.attribute("crs:Exposure2012"))
            assertEquals("0.25", persisted.attribute("crs:CropLeft"))
            model.setComparingBefore(false)
            withTimeout(10_000) { while (renderer.latest?.values?.get("exposure") != 2f) yield() }
            assertEquals(persisted.serialize(), renderer.latest!!.document.serialize())
            model.back()
        } finally {
            raw.delete()
            Dispatchers.resetMain()
        }
    }
}
