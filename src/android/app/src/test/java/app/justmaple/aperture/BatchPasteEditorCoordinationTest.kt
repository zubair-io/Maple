package app.justmaple.aperture

import android.net.Uri
import android.view.Surface
import androidx.lifecycle.viewModelScope
import app.justmaple.aperture.data.*
import app.justmaple.aperture.generated.AdjustmentTransfer
import java.io.File
import java.nio.file.Files
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
class BatchPasteEditorCoordinationTest {
    private class IdleRenderer : PreviewRenderer {
        override val hasPresented = false
        override var revision = 0
        override fun invalidateDraws() = ++revision
        override fun invalidateModel() {}
        override suspend fun open(path: String, document: String, edge: Int, generation: Int) = emptyMap<String, Float>()
        override suspend fun modelValues(document: String): Map<String, Float> = error("Unexpected model request")
        override suspend fun sampleMaskRange(document: String, x: Float, y: Float): String = error("Unexpected sample")
        override suspend fun autoWhiteBalance(document: String): WhiteBalanceRecommendation = error("Unexpected analysis")
        override suspend fun nativeDimensions(photo: Photo): NativeImageSize? = null
        override suspend fun nativeDetail(request: NativeDetailRequest): android.graphics.Bitmap = error("Unexpected detail")
        override fun cancelNativeDetail() {}
        override fun recordSurface(next: Surface?, w: Int, h: Int, wideColor: Boolean) = EditorRenderer.SurfaceBinding(next, w, h, wideColor)
        override suspend fun attach(binding: EditorRenderer.SurfaceBinding) {}
        override suspend fun draw(next: Map<String, Float>, expectedRevision: Int, xml: String) {}
        override suspend fun refine(expectedRevision: Int) {}
        override suspend fun shutdown() {}
        override fun close() {}
    }

    @Test fun aRunningPasteCannotLeaveAnOpenEditorWithAnObsoleteSaveBaseline() = runBlocking {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        val application = RuntimeEnvironment.getApplication()
        val library = PhotoLibrary(application)
        val directory = Files.createTempDirectory("batch-editor-").toFile()
        val original = File(directory, "target.dng").apply { writeText("read-only original") }
        val photo = Photo(Uri.fromFile(original), original.name, original.length(), original.lastModified(), null)
        val began = CompletableDeferred<Unit>()
        val finish = CompletableDeferred<Unit>()
        val batch = BatchSettingsTransfer(File(directory, "ledger.json"), library::loadSidecar) { target, document, baseline ->
            began.complete(Unit)
            finish.await()
            library.save(target, document, baseline)
        }
        val model = MapleViewModel(application, library, IdleRenderer(), batch)
        var job: Job? = null
        try {
            library.save(photo, XmpDocument().withAttribute("crs:Exposure2012", "-1"), null)
            batch.prepare(listOf(photo), CopiedSettings("source.dng",
                XmpDocument().withAttribute("crs:Exposure2012", "1.25")),
                listOf(AdjustmentTransfer.groups.first { it.id == "tone" }))
            job = launch(Dispatchers.Default) { batch.run() }
            withTimeout(10_000) { began.await() }
            model.openFromBrowse(photo, listOf(photo))
            val blocked = withTimeout(10_000) { model.state.first { it.selected != null || it.error != null } }
            assertEquals(PhotoMode.Browse, blocked.mode)
            assertNull(blocked.selected)
            assertTrue(blocked.error.orEmpty().contains("batch paste"))
            finish.complete(Unit)
            job.join()
            model.clearError()
            model.openFromBrowse(photo, listOf(photo))
            val opened = withTimeout(10_000) { model.state.first { it.documentLoaded && !it.loading } }
            assertEquals("1.25", opened.document.attribute("crs:Exposure2012"))
            model.attribute("xmp:Rating", "4")
            assertTrue(model.flush())
            assertEquals("4", library.loadSidecar(photo).document.attribute("xmp:Rating"))
            assertEquals("read-only original", original.readText())
        } finally {
            finish.complete(Unit)
            job?.join()
            model.viewModelScope.cancel()
            File(application.filesDir, "sidecars/${PhotoLibrary.digest("private-sidecar-v3:${photo.key}")}.xmp").delete()
            directory.deleteRecursively()
            Dispatchers.resetMain()
        }
    }
}
