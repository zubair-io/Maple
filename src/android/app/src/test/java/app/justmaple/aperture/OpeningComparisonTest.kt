package app.justmaple.aperture

import app.justmaple.aperture.generated.AdjustmentFields
import app.justmaple.aperture.ui.EditorGroup
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
        override suspend fun nativeDimensions(photo: app.justmaple.aperture.data.Photo): app.justmaple.aperture.data.NativeImageSize? = null
        override suspend fun nativeDetail(request: app.justmaple.aperture.data.NativeDetailRequest): android.graphics.Bitmap = error("Native detail is not requested by this fixture")
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

    @Test
    fun resettingDetailPreservesFramingAndUndoRestoresDetail() = runBlocking {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        val app = RuntimeEnvironment.getApplication()
        val raw = File.createTempFile("detail-reset-", ".dng", app.cacheDir).apply { writeText("renderer seam") }
        val photo = Photo(Uri.fromFile(raw), raw.name, raw.length(), raw.lastModified(), null)
        val library = PhotoLibrary(app)
        val opening = XmpDocument().withAttribute("crs:HasCrop", "True")
            .withAttribute("crs:CropLeft", "0.2").withAttribute("crs:CropTop", "0.1")
            .withAttribute("crs:CropBottom", "0.9").withAttribute("crs:CropRight", "0.8")
            .withAttribute("crs:CropAngle", "2.5")
        library.save(photo, opening, null)
        val model = MapleViewModel(app, library, RecordingRenderer())
        try {
            model.open(photo)
            withTimeout(10_000) { model.state.first { it.documentLoaded && !it.loading } }
            model.edit()
            withTimeout(10_000) { model.state.first { it.values.isNotEmpty() } }
            model.setField("sharpen_amount", 75f)
            model.commitGesture()
            val sharpened = model.state.value.document.serialize()
            model.resetGroup(EditorGroup.Detail)
            for (key in listOf("HasCrop", "CropLeft", "CropTop", "CropBottom", "CropRight", "CropAngle")) {
                assertEquals(opening.attribute("crs:$key"), model.state.value.document.attribute("crs:$key"))
            }
            assertEquals(AdjustmentFields.byName.getValue("sharpen_amount").initial, model.state.value.values["sharpen_amount"]!!, 0f)
            assertTrue(model.flush())
            assertEquals("2.5", library.loadSidecar(photo).document.attribute("crs:CropAngle"))
            model.undo()
            assertEquals(sharpened, model.state.value.document.serialize())
            model.back()
            withTimeout(10_000) { model.state.first { it.mode == PhotoMode.Preview && !it.saving } }
            Unit
        } finally {
            raw.delete()
            Dispatchers.resetMain()
        }
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
            assertFalse("Opening sidecar edits are the Before snapshot", model.hasComparisonEdits())
            model.setField("exposure", 0f)
            model.commitGesture()
            assertTrue("Resetting an opening edit still differs from Before", model.hasComparisonEdits())
            model.undo()
            assertFalse("Undo restores the opening snapshot", model.hasComparisonEdits())
            model.attribute("crs:CropLeft", "0.25")
            assertFalse("A crop-only edit is applied to both comparison states", model.hasComparisonEdits())
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
            withTimeout(10_000) { model.state.first { it.mode == PhotoMode.Preview } }
            model.edit()
            withTimeout(10_000) { model.state.first { it.mode == PhotoMode.Edit && it.values.isNotEmpty() } }
            assertFalse("Reopening Edit adopts the current saved document as Before", model.hasComparisonEdits())
            model.setComparingBefore(true)
            withTimeout(10_000) { while (renderer.latest?.values?.get("exposure") != 2f) yield() }
            model.back()
        } finally {
            raw.delete()
            Dispatchers.resetMain()
        }
    }
}
