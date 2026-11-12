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

/**
 * #4669: the renderer adopts a name-only imported Auto pair after the As Shot first frame. The view
 * model must show it everywhere the request still stands, so no later draw hands the renderer the
 * As Shot sliders (which EditorDrawPlan would push and author over the estimate).
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class ImportedAutoWhiteBalanceTest {
    private class AdoptingRenderer : PreviewRenderer {
        override val hasPresented = true
        override var revision = 0
        var generation = -1
        var listener: ((Int, Result<Map<String, Float>>) -> Unit)? = null
        val draws = mutableListOf<Map<String, Float>>()
        override fun invalidateDraws() = ++revision
        override fun invalidateModel() {}
        override suspend fun open(path: String, document: String, edge: Int, generation: Int): Map<String, Float> {
            this.generation = generation
            return AS_SHOT
        }
        override fun observeImportedWhiteBalance(listener: (Int, Result<Map<String, Float>>) -> Unit) {
            this.listener = listener
        }
        fun adopt(outcome: Result<Map<String, Float>> = Result.success(ESTIMATE)) =
            requireNotNull(listener)(generation, outcome)
        override suspend fun autoWhiteBalance(document: String): WhiteBalanceRecommendation = error("Not expected")
        override suspend fun nativeDimensions(photo: Photo): NativeImageSize? = null
        override suspend fun nativeDetail(request: NativeDetailRequest): android.graphics.Bitmap = error("Not expected")
        override fun cancelNativeDetail() {}
        override fun recordSurface(next: Surface?, w: Int, h: Int, wideColor: Boolean) =
            EditorRenderer.SurfaceBinding(next, w, h, wideColor)
        override suspend fun attach(binding: EditorRenderer.SurfaceBinding) {}
        override suspend fun draw(next: Map<String, Float>, expectedRevision: Int, xml: String) {
            draws += next
        }
        override suspend fun refine(expectedRevision: Int) {}
        override suspend fun shutdown() {}
        override fun close() {}
    }

    private suspend fun exercise(
        document: XmpDocument = XmpDocument().withAttribute("crs:WhiteBalance", "Auto"),
        body: suspend (MapleViewModel, AdoptingRenderer, PhotoLibrary, Photo) -> Unit,
    ) {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        val app = RuntimeEnvironment.getApplication()
        val raw = File.createTempFile("imported-auto-wb-", ".dng", app.cacheDir).apply { writeText("renderer seam") }
        val photo = Photo(Uri.fromFile(raw), raw.name, raw.length(), raw.lastModified(), null)
        val library = PhotoLibrary(app)
        val renderer = AdoptingRenderer()
        val model = MapleViewModel(app, library, renderer)
        library.save(photo, document, null)
        try {
            model.open(photo)
            withTimeout(10_000) { model.state.first { it.documentLoaded && !it.loading } }
            model.edit()
            withTimeout(10_000) { model.state.first { it.values.isNotEmpty() } }
            body(model, renderer, library, photo)
        } finally {
            raw.delete()
            Dispatchers.resetMain()
        }
    }

    /** What EditorRenderer would push after reloading a model that renders the estimate. */
    private fun whiteBalancePushes(next: Map<String, Float>): List<String> = buildList {
        EditorDrawPlan.forEachFieldToApply(ESTIMATE, next, importedWhiteBalance = false) { field, _ ->
            if (field.name == "temperature" || field.name == "tint") add(field.name)
        }
    }

    private fun MapleViewModel.whiteBalance() =
        state.value.values.getValue("temperature") to state.value.values.getValue("tint")

    private suspend fun AdoptingRenderer.drawn(exposure: Float): Map<String, Float> =
        withTimeout(10_000) {
            while (draws.lastOrNull()?.get("exposure") != exposure) yield()
            draws.last()
        }

    @Test
    fun theAdoptedPairSurvivesTheNextEditUndoAndBeforeAndTheSidecarStaysNameOnly() = runBlocking {
        exercise { model, renderer, library, photo ->
            // An edit made before the estimate lands leaves an As Shot undo snapshot.
            model.setField("exposure", 0.25f)
            model.commitGesture()
            renderer.adopt()
            assertEquals(5100f to 9f, model.whiteBalance())

            model.setField("exposure", 0.5f)
            model.commitGesture()
            val edited = renderer.drawn(0.5f)
            assertEquals(5100f to 9f, edited.getValue("temperature") to edited.getValue("tint"))
            assertEquals(emptyList<String>(), whiteBalancePushes(edited))

            model.undo()
            model.undo()
            assertEquals(5100f to 9f, model.whiteBalance())
            assertEquals(emptyList<String>(), whiteBalancePushes(renderer.drawn(0f)))

            model.redo()
            renderer.drawn(0.25f)
            model.setComparingBefore(true)
            assertEquals(emptyList<String>(), whiteBalancePushes(renderer.drawn(0f)))
            model.setComparingBefore(false)

            assertTrue(model.flush())
            val saved = library.loadSidecar(photo).document
            assertEquals("Auto", saved.attribute("crs:WhiteBalance"))
            assertNull(saved.attribute("crs:Temperature"))
            assertNull(saved.attribute("crs:Tint"))
        }
    }

    @Test
    fun adoptionDuringAGestureRecordsNoUndoStepAndNoComparisonEdit() = runBlocking {
        exercise { model, renderer, _, _ ->
            model.beginGesture()
            renderer.adopt()
            model.commitGesture()
            assertFalse(model.state.value.canUndo)
            assertFalse(model.hasComparisonEdits())
        }
    }

    @Test
    fun aWhiteBalanceEditMadeBeforeTheEstimateLandsIsNeverReplaced() = runBlocking {
        exercise { model, renderer, _, _ ->
            model.setField("temperature", 6000f)
            renderer.adopt()
            assertEquals(6000f, model.state.value.values.getValue("temperature"), 0f)
            assertEquals("6000", model.state.value.document.attribute("crs:Temperature"))
        }
    }

    @Test
    fun aFailedReRenderIsReportedAndAPairForAnEarlierSessionIsIgnored() = runBlocking {
        exercise { model, renderer, _, _ ->
            val first = renderer.generation
            renderer.adopt(Result.failure(IllegalStateException("surface lost")))
            assertEquals(5200f to 12f, model.whiteBalance())
            assertNotNull(model.state.value.error)
            model.clearError()
            model.back()
            withTimeout(10_000) { model.state.first { it.mode == PhotoMode.Preview } }
            requireNotNull(renderer.listener)(first, Result.success(ESTIMATE))
            assertEquals(5200f to 12f, model.whiteBalance())
            model.edit()
            withTimeout(10_000) { model.state.first { it.mode == PhotoMode.Edit && it.values.isNotEmpty() } }
            assertEquals(5200f to 12f, model.whiteBalance())
        }
    }

    private companion object {
        val AS_SHOT = mapOf(
            "temperature" to 5200f, "tint" to 12f, "_shot_temperature" to 5200f,
            "_shot_tint" to 12f, "_raw" to 1f, "exposure" to 0f,
        )
        val ESTIMATE = AS_SHOT + mapOf("temperature" to 5100f, "tint" to 9f)
    }
}
