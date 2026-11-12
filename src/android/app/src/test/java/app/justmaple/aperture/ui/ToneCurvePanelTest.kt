package app.justmaple.aperture.ui

import android.net.Uri
import android.view.Surface
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.unit.dp
import app.justmaple.aperture.EditSnapshot
import app.justmaple.aperture.MapleViewModel
import app.justmaple.aperture.data.*
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

/**
 * Drags on the real panel drive the real ViewModel, undo history and
 * PhotoLibrary sidecar writer; only the JNI renderer and plot sampler are seams.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class ToneCurvePanelTest {
    @get:Rule val compose = createComposeRule()

    private class RecordingRenderer : PreviewRenderer {
        override val hasPresented = true
        override var revision = 0
        var latest: EditSnapshot? = null
        override fun invalidateDraws() = ++revision
        override fun invalidateModel() {}
        override suspend fun open(path: String, document: String, edge: Int, generation: Int) =
            mapOf("exposure" to 0f, "_raw" to 1f, "parametric_shadows" to 0f)
        override suspend fun modelValues(document: String): Map<String, Float> = error("Settings paste is not exercised by this test")
        override suspend fun sampleMaskRange(document: String, x: Float, y: Float): String = error("Colour sampling is not exercised by this test")
        override suspend fun autoWhiteBalance(document: String): app.justmaple.aperture.WhiteBalanceRecommendation = error("White balance analysis is not expected in this test")
        override suspend fun nativeDimensions(photo: Photo): NativeImageSize? = null
        override suspend fun nativeDetail(request: NativeDetailRequest): android.graphics.Bitmap = error("Native detail is not requested by this fixture")
        override fun cancelNativeDetail() {}
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

    private lateinit var raw: File
    private lateinit var photo: Photo
    private lateinit var library: PhotoLibrary
    private lateinit var renderer: RecordingRenderer
    private lateinit var model: MapleViewModel

    @Before
    fun setUp() = runBlocking {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        val app = RuntimeEnvironment.getApplication()
        raw = File.createTempFile("curve-", ".dng", app.cacheDir).apply { writeText("renderer seam") }
        photo = Photo(Uri.fromFile(raw), raw.name, raw.length(), raw.lastModified(), null)
        library = PhotoLibrary(app)
        renderer = RecordingRenderer()
        model = MapleViewModel(app, library, renderer)
        model.open(photo)
        withTimeout(10_000) { model.state.first { it.documentLoaded && !it.loading } }
        model.edit()
        withTimeout(10_000) { model.state.first { it.canEdit } }
        Unit
    }

    @After
    fun tearDown() {
        raw.delete()
        Dispatchers.resetMain()
    }

    private fun showPanel(): () -> ToneCurveFamily {
        var family by mutableStateOf(ToneCurveFamily.Scene)
        compose.setContent {
            val state by model.state.collectAsState()
            Box(Modifier.size(320.dp, 600.dp)) {
                ToneCurvePanel(model, state, family, { family = it }, sampler = { FloatArray(129) { i -> i / 128f } })
            }
        }
        return { family }
    }

    @Test
    fun aDragAddsOneKnotAsOneUndoEntryAndPersistsTheCurve() {
        showPanel()
        compose.onNodeWithTag("tone-curve-plot").performTouchInput {
            down(Offset(width * .5f, height * .5f))
            moveTo(Offset(width * .5f, height * .3f))
            moveTo(Offset(width * .5f, height * .25f))
            up()
        }
        compose.runOnIdle {
            val knots = model.state.value.document.curve(PointCurve.SceneLuma)
            assertEquals(3, knots.size)
            assertEquals(.5f, knots[1].x, .01f)
            assertEquals(.75f, knots[1].y, .01f)
            assertEquals(knots, renderer.latest!!.document.curve(PointCurve.SceneLuma))
        }
        compose.onNodeWithTag("tone-curve-knot-readout").assertExists()
        compose.onNodeWithTag("tone-curve-reset").assertIsEnabled()
        assertTrue(runBlocking { model.flush() })
        val saved = runBlocking { library.loadSidecar(photo) }.document
        assertEquals(3, saved.curve(PointCurve.SceneLuma).size)
        assertTrue(saved.original.contains("<papp:SceneLinearToneCurve>"))

        compose.runOnIdle { model.undo() }
        compose.runOnIdle {
            assertTrue("One drag is one undo entry", model.state.value.document.curve(PointCurve.SceneLuma).isEmpty())
            assertFalse(model.state.value.canUndo)
        }
    }

    @Test
    fun deletingAKnotAndResettingAChannelReturnToTheIdentity() {
        val family = showPanel()
        compose.onNodeWithTag("tone-curve-family-display").performClick()
        compose.runOnIdle { assertEquals(ToneCurveFamily.Display, family()) }
        compose.onNodeWithTag("tone-curve-channel-r").performClick()
        compose.onNodeWithTag("tone-curve-reset").assertIsNotEnabled()
        compose.onNodeWithTag("tone-curve-plot").performTouchInput {
            down(Offset(width * .4f, height * .5f))
            moveTo(Offset(width * .4f, height * .4f))
            up()
        }
        compose.runOnIdle {
            assertEquals(3, model.state.value.document.curve(PointCurve.DisplayRed).size)
            assertTrue(model.state.value.document.curve(PointCurve.SceneLuma).isEmpty())
        }
        compose.onNodeWithTag("tone-curve-delete-knot").performClick()
        compose.runOnIdle { assertTrue(model.state.value.document.curve(PointCurve.DisplayRed).isEmpty()) }

        compose.onNodeWithTag("tone-curve-plot").performTouchInput {
            down(Offset(width * .6f, height * .5f))
            moveTo(Offset(width * .6f, height * .2f))
            up()
        }
        compose.onNodeWithTag("tone-curve-reset").performClick()
        compose.runOnIdle {
            assertTrue(model.state.value.document.curve(PointCurve.DisplayRed).isEmpty())
            model.undo()
            assertEquals(3, model.state.value.document.curve(PointCurve.DisplayRed).size)
        }
    }

    @Test
    fun theModeRowWritesRatioPreservingAndBackToTheOmittedDefault() {
        showPanel()
        compose.onNodeWithTag("tone-curve-mode-ratio").performClick()
        compose.runOnIdle { assertEquals("RatioPreserving", model.state.value.document.attribute("papp:ToneCurveMode")) }
        compose.onNodeWithTag("tone-curve-mode-per-channel").performClick()
        compose.runOnIdle { assertNull(model.state.value.document.attribute("papp:ToneCurveMode")) }
    }
}
