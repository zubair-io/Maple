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
class AutoWhiteBalanceTest {
    private class Analyzer : PreviewRenderer {
        override val hasPresented = true
        override var revision = 0
        val result = CompletableDeferred<WhiteBalanceRecommendation>()
        var requests = 0
        override fun invalidateDraws() = ++revision
        override fun invalidateModel() {}
        override suspend fun open(path: String, document: String, edge: Int, generation: Int) =
            mapOf("temperature" to 5200f, "tint" to 12f, "_shot_temperature" to 5200f,
                "_shot_tint" to 12f, "_raw" to 1f, "exposure" to 1f)
        override suspend fun autoWhiteBalance(document: String): WhiteBalanceRecommendation {
            requests++
            return withContext(NonCancellable) { result.await() }
        }
        override suspend fun nativeDimensions(photo: app.justmaple.aperture.data.Photo): app.justmaple.aperture.data.NativeImageSize? = null
        override suspend fun nativeDetail(request: app.justmaple.aperture.data.NativeDetailRequest): android.graphics.Bitmap = error("Native detail is not requested by this fixture")
        override fun cancelNativeDetail() {}
        override fun recordSurface(next: Surface?, w: Int, h: Int, wideColor: Boolean) =
            EditorRenderer.SurfaceBinding(next, w, h, wideColor)
        override suspend fun attach(binding: EditorRenderer.SurfaceBinding) {}
        override suspend fun draw(next: Map<String, Float>, expectedRevision: Int, xml: String) {}
        override suspend fun refine(expectedRevision: Int) {}
        override suspend fun shutdown() {}
        override fun close() {}
    }

    private suspend fun exercise(body: suspend (MapleViewModel, Analyzer, PhotoLibrary, Photo) -> Unit) {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        val app = RuntimeEnvironment.getApplication()
        val raw = File.createTempFile("auto-wb-", ".dng", app.cacheDir).apply { writeText("renderer seam") }
        val photo = Photo(Uri.fromFile(raw), raw.name, raw.length(), raw.lastModified(), null)
        val library = PhotoLibrary(app)
        val analyzer = Analyzer()
        val model = MapleViewModel(app, library, analyzer)
        val initial = XmpDocument().withAttribute("crs:Exposure2012", "1")
            .withAttribute("xmp:Label", "retain metadata").withAttribute("crs:CropLeft", "0.2")
        library.save(photo, initial, null)
        try {
            model.open(photo)
            withTimeout(10_000) { model.state.first { it.documentLoaded && !it.loading } }
            model.edit()
            withTimeout(10_000) { model.state.first { it.values.isNotEmpty() } }
            body(model, analyzer, library, photo)
            model.flush()
            model.back()
        } finally {
            analyzer.result.complete(WhiteBalanceRecommendation(6200f, 8f, 3f))
            raw.delete()
            Dispatchers.resetMain()
        }
    }

    @Test
    fun appliesOneSharedRecommendationAsOneUndoableRealSidecarSave() = runBlocking {
        exercise { model, analyzer, library, photo ->
            model.autoWhiteBalance()
            model.autoWhiteBalance()
            assertEquals(1, analyzer.requests)
            assertTrue(model.state.value.autoWhiteBalanceInFlight)
            analyzer.result.complete(WhiteBalanceRecommendation(6200f, 8f, 3f))
            withTimeout(10_000) { model.state.first { !it.autoWhiteBalanceInFlight } }
            assertEquals(6200f, model.state.value.values.getValue("temperature"), 0f)
            assertTrue(model.flush())
            val saved = library.loadSidecar(photo).document
            assertEquals("Auto", saved.attribute("crs:WhiteBalance"))
            assertEquals("Auto", saved.attribute("papp:WbSource"))
            assertEquals("3", saved.attribute("papp:WbAlgorithmVersion"))
            assertEquals("retain metadata", saved.attribute("xmp:Label"))
            assertEquals("0.2", saved.attribute("crs:CropLeft"))
            assertEquals("1", saved.attribute("crs:Exposure2012"))
            model.undo()
            assertEquals(5200f, model.state.value.values.getValue("temperature"), 0f)
            assertNull(model.state.value.document.attribute("papp:WbSource"))
            assertFalse(model.state.value.canUndo)
        }
    }

    @Test
    fun anEditFollowedByUndoStillRejectsTheStaleAnalysis() = runBlocking {
        exercise { model, analyzer, _, _ ->
            val before = model.state.value.document.serialize()
            model.autoWhiteBalance()
            model.setField("exposure", 2f)
            model.commitGesture()
            model.undo()
            analyzer.result.complete(WhiteBalanceRecommendation(6200f, 8f, 3f))
            withTimeout(10_000) { model.state.first { !it.autoWhiteBalanceInFlight } }
            assertEquals(before, model.state.value.document.serialize())
            assertEquals(5200f, model.state.value.values.getValue("temperature"), 0f)
        }
    }

    @Test
    fun leavingTheEditorDoesNotApplyAnAnalysisThatFinishesLater() = runBlocking {
        exercise { model, analyzer, _, _ ->
            val before = model.state.value.document.serialize()
            model.autoWhiteBalance()
            model.back()
            withTimeout(10_000) { model.state.first { it.mode == PhotoMode.Preview } }
            analyzer.result.complete(WhiteBalanceRecommendation(6200f, 8f, 3f))
            yield()
            assertEquals(before, model.state.value.document.serialize())
            assertFalse(model.state.value.autoWhiteBalanceInFlight)
        }
    }
}
