package app.justmaple.aperture.ui

import android.net.Uri
import android.view.Surface
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsOff
import androidx.compose.ui.test.assertIsOn
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import app.justmaple.aperture.MapleViewModel
import app.justmaple.aperture.data.*
import app.justmaple.aperture.generated.AdjustmentTransfer
import app.justmaple.aperture.generated.AdjustmentTransferGroup
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
 * The header menu and group picker drive the real ViewModel, undo history and
 * PhotoLibrary sidecar writer; only the JNI renderer is a seam.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class PasteSettingsTest {
    @get:Rule val compose = createComposeRule()

    private class ModelRenderer : PreviewRenderer {
        override val hasPresented = true
        override var revision = 0
        var latest: Pair<Map<String, Float>, XmpDocument>? = null
        var modelReads = 0
        private fun values(document: String) =
            mapOf("exposure" to (XmpDocument(document).attribute("crs:Exposure2012")?.toFloat() ?: 0f), "_raw" to 1f)
        override fun invalidateDraws() = ++revision
        override fun invalidateModel() {}
        override suspend fun open(path: String, document: String, edge: Int, generation: Int) = values(document)
        override suspend fun modelValues(document: String) = values(document).also { modelReads++ }
        override suspend fun sampleMaskRange(document: String, x: Float, y: Float): String = error("Colour sampling is not exercised by this test")
        override suspend fun autoWhiteBalance(document: String): app.justmaple.aperture.WhiteBalanceRecommendation = error("White balance analysis is not expected in this test")
        override suspend fun nativeDimensions(photo: Photo): NativeImageSize? = null
        override suspend fun nativeDetail(request: NativeDetailRequest): android.graphics.Bitmap = error("Native detail is not requested by this fixture")
        override fun cancelNativeDetail() {}
        override fun recordSurface(next: Surface?, w: Int, h: Int, wideColor: Boolean) =
            EditorRenderer.SurfaceBinding(next, w, h, wideColor)
        override suspend fun attach(binding: EditorRenderer.SurfaceBinding) {}
        override suspend fun draw(next: Map<String, Float>, expectedRevision: Int, xml: String) {
            latest = next to XmpDocument(xml)
        }
        override suspend fun refine(expectedRevision: Int) {}
        override suspend fun shutdown() {}
        override fun close() {}
    }

    private val foreign = "<f:keep xmlns:f=\"urn:foreign\"><f:x>target bytes &amp; more</f:x></f:keep>"
    private val sourceXml =
        """<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" xmlns:papp="http://ns.justmaple.app/photo/1.0/"
  crs:Exposure2012="1.25" crs:Saturation="-30">
  <papp:SceneLinearToneCurve><rdf:Seq><rdf:li>0, 0</rdf:li><rdf:li>128, 160</rdf:li><rdf:li>255, 255</rdf:li></rdf:Seq></papp:SceneLinearToneCurve>
</rdf:Description></rdf:RDF></x:xmpmeta>"""
    private val targetXml =
        """<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
  crs:Exposure2012="-0.5" crs:Saturation="10">
  $foreign
</rdf:Description></rdf:RDF></x:xmpmeta>"""

    private lateinit var files: List<File>
    private lateinit var source: Photo
    private lateinit var target: Photo
    private lateinit var library: PhotoLibrary
    private lateinit var renderer: ModelRenderer
    private lateinit var model: MapleViewModel

    @Before
    fun setUp() = runBlocking {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        val app = RuntimeEnvironment.getApplication()
        files = listOf("source-", "target-").map {
            File.createTempFile(it, ".dng", app.cacheDir).apply { writeText("renderer seam") }
        }
        val (sourceFile, targetFile) = files
        source = Photo(Uri.fromFile(sourceFile), sourceFile.name, sourceFile.length(), sourceFile.lastModified(), null)
        target = Photo(Uri.fromFile(targetFile), targetFile.name, targetFile.length(), targetFile.lastModified(), null)
        library = PhotoLibrary(app)
        library.save(source, XmpDocument(sourceXml), null)
        library.save(target, XmpDocument(targetXml), null)
        renderer = ModelRenderer()
        model = MapleViewModel(app, library, renderer)
        model.open(source)
        withTimeout(10_000) { model.state.first { it.documentLoaded && !it.loading } }
        model.copySettings()
        model.open(target)
        withTimeout(10_000) { model.state.first { it.documentLoaded && !it.loading && it.selected == target } }
        model.edit()
        withTimeout(10_000) { model.state.first { it.canEdit } }
        Unit
    }

    @After
    fun tearDown() {
        files.forEach(File::delete)
        Dispatchers.resetMain()
    }

    @Test
    fun theHeaderPastesTheReviewedGroupsAsOneUndoEntryAndPersistsThem() {
        assertEquals(source.name, model.state.value.copiedSettings?.sourceName)
        compose.setContent {
            val state by model.state.collectAsState()
            FloatingPhotoHeader(model, state, null, adjustments = false, onAdjustments = {}, onInfo = {}, onExport = {})
        }
        compose.onNodeWithContentDescription("More photo actions").performClick()
        compose.onNodeWithTag("paste-settings").performClick()
        compose.onNodeWithTag("paste-settings-dialog").assertExists()
        compose.onNodeWithTag("paste-preview-tone").assertExists()
        compose.onNodeWithContentDescription("Exposure: -0.5 to 1.25").assertExists()
        compose.onNodeWithContentDescription("Saturation: 10 to -30").assertExists()
        compose.onNodeWithTag("paste-group-color").assertIsOn().performScrollTo().performClick()
        compose.onNodeWithTag("paste-group-color").assertIsOff()
        compose.onNodeWithTag("paste-preview-color").assertDoesNotExist()
        compose.onNodeWithTag("paste-settings-apply").performClick()
        compose.onNodeWithTag("paste-settings-dialog").assertDoesNotExist()

        compose.runOnIdle {
            val state = model.state.value
            assertEquals("1.25", state.document.attribute("crs:Exposure2012"))
            assertEquals("Color was unchecked", "10", state.document.attribute("crs:Saturation"))
            assertEquals(3, state.document.curve(PointCurve.SceneLuma).size)
            assertEquals(1.25f, state.values.getValue("exposure"), 0f)
            assertEquals(1, renderer.modelReads)
            assertEquals(1.25f, renderer.latest!!.first.getValue("exposure"), 0f)
            assertTrue(state.canUndo)
        }
        assertTrue(runBlocking { model.flush() })
        val saved = runBlocking { library.loadSidecar(target) }.document
        assertEquals("1.25", saved.attribute("crs:Exposure2012"))
        assertEquals(3, saved.curve(PointCurve.SceneLuma).size)
        assertTrue(saved.original.contains(foreign))

        compose.runOnIdle { model.undo() }
        compose.runOnIdle {
            val state = model.state.value
            assertEquals("One paste is one undo entry", "-0.5", state.document.attribute("crs:Exposure2012"))
            assertTrue(state.document.curve(PointCurve.SceneLuma).isEmpty())
            assertFalse(state.canUndo)
            model.redo()
            assertEquals("1.25", model.state.value.document.attribute("crs:Exposure2012"))
        }
    }

    @Test
    fun thePickerOffersEveryGroupAndPastesOnlyTheCheckedOnes() {
        val copied = model.state.value.copiedSettings!!
        var chosen: List<AdjustmentTransferGroup>? = null
        compose.setContent {
            PasteSettingsDialog(model.state.value.document, copied, raw = true, onPaste = { chosen = it }, onDismiss = {})
        }
        for (group in AdjustmentTransfer.groups) compose.onNodeWithTag("paste-group-${group.id}").performClick()
        compose.onNodeWithTag("paste-settings-apply").assertIsNotEnabled()
        compose.onNodeWithTag("paste-preview-tone").assertDoesNotExist()
        compose.onNodeWithTag("paste-group-tone").performClick()
        compose.onNodeWithTag("paste-preview-tone").assertExists()
        compose.onNodeWithTag("paste-settings-apply").assertIsEnabled().performClick()
        assertEquals(listOf("tone"), chosen?.map { it.id })
    }
}
