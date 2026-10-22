package app.justmaple.aperture

import android.net.Uri
import android.view.Surface
import app.justmaple.aperture.data.*
import java.io.File
import java.io.IOException
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
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

/**
 * A photo whose storage stops answering must not wedge the app (#4765): a
 * failed "Reload saved edits" keeps the document loaded and saveable, and
 * "Discard unsaved edits" unblocks navigation without any I/O. The sidecar
 * layer is the real PhotoLibrary writing real .xmp files under the app's
 * private storage; the failure is induced at the filesystem by turning the
 * saved sidecar into a directory, so both read and write throw. Only the
 * JNI renderer is substituted.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class MapleViewModelRecoveryTest {
    private class IdleRenderer : PreviewRenderer {
        override val hasPresented = false
        override var revision = 0
        override fun invalidateDraws() = ++revision
        override fun invalidateModel() {}
        override suspend fun open(path: String, document: String, edge: Int, generation: Int) = emptyMap<String, Float>()
        override suspend fun autoWhiteBalance(document: String): app.justmaple.aperture.WhiteBalanceRecommendation = error("White balance analysis is not expected in this test")
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

    // parent == null: the sidecar lives in the app's private storage, not SAF.
    private val photo = Photo(Uri.parse("file:///photos/photo.dng"), "photo.dng", 1, 1, null)
    private lateinit var model: MapleViewModel
    private lateinit var sidecars: File

    private fun await(what: String, predicate: (MapleState) -> Boolean): MapleState =
        runBlocking { withTimeout(10_000) { model.state.first(predicate) } }
            .also { assertTrue(what, predicate(it)) }

    private fun savedSidecar(): File =
        sidecars.listFiles { file -> file.name.endsWith(".xmp") }?.singleOrNull()
            ?: fail("expected exactly one saved sidecar in $sidecars") as File

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        val application = RuntimeEnvironment.getApplication()
        sidecars = File(application.filesDir, "sidecars")
        model = MapleViewModel(application, PhotoLibrary(application), IdleRenderer())

        model.open(photo)
        await("document loads") { it.documentLoaded && !it.loading }
        model.attribute("xmp:Rating", "3")
        assertTrue(runBlocking { model.flush() })
        await("first edit is saved") { !it.dirty }
        assertTrue(XmpDocument(savedSidecar().readText()).attribute("xmp:Rating") == "3")

        model.attribute("xmp:Rating", "4")
        assertTrue(model.state.value.dirty)
        // Storage goes away: the sidecar path is now a directory, so reading
        // and writing it both throw inside PhotoLibrary.
        val saved = savedSidecar()
        assertTrue(saved.delete())
        assertTrue(saved.mkdir())
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
        sidecars.deleteRecursively()
    }

    @Test
    fun failedReloadKeepsTheDocumentLoadedAndDirty() {
        model.reloadSavedEdits()

        val state = await("reload reports its failure") { it.error != null }
        assertTrue(state.error, state.error!!.startsWith("Could not reload saved edits"))
        assertTrue(state.documentLoaded)
        assertTrue(state.dirty)
        assertFalse(state.loading)
        assertEquals("4", state.document.attribute("xmp:Rating"))
    }

    @Test
    fun failedReloadThenFailedSave_IsRecoveredByDiscard() {
        model.reloadSavedEdits()
        await("reload reports its failure") { it.error != null }
        model.clearError()

        model.back()
        val blocked = await("navigation is refused while the save fails") { it.error != null }
        assertTrue(blocked.error, blocked.error!!.startsWith("Could not save edits"))
        assertEquals(PhotoMode.Preview, blocked.mode)

        model.discardUnsavedEdits()
        val discarded = await("edits are discarded") { !it.dirty }
        assertTrue(discarded.documentLoaded)
        assertNull(discarded.error)
        assertEquals("3", discarded.document.attribute("xmp:Rating"))
        assertTrue("discard must not write", savedSidecar().isDirectory)

        model.back()
        await("navigation proceeds") { it.mode == PhotoMode.Browse }
    }

    @Test
    fun failedReloadWithNothingUnsaved_RevertsToUnloadedUntilAReloadSucceeds() {
        // The contract FailedSidecarLoadTest pins on a device: with no edits
        // to lose, a failed reload blocks writes from the stale document.
        model.discardUnsavedEdits()
        await("edits are discarded") { !it.dirty }

        model.reloadSavedEdits()
        val failed = await("reload reports its failure") { it.error != null }
        assertFalse(failed.documentLoaded)
        assertFalse(failed.canChangeMetadata)
        model.clearError()
        model.attribute("xmp:Rating", "5")
        assertFalse(model.state.value.dirty)

        // Storage comes back.
        val saved = savedSidecar()
        assertTrue(saved.delete())
        saved.writeText(XmpDocument().withAttribute("xmp:Rating", "3").serialize())
        model.reloadSavedEdits()
        val loaded = await("reload succeeds") { it.documentLoaded && it.error == null }
        assertEquals("3", loaded.document.attribute("xmp:Rating"))
    }

    @Test
    fun discardIsANoOpWithoutUnsavedEdits() {
        model.discardUnsavedEdits()
        await("edits are discarded") { !it.dirty }

        model.discardUnsavedEdits()
        val state = model.state.value
        assertTrue(state.documentLoaded)
        assertNull(state.error)
        assertEquals("3", state.document.attribute("xmp:Rating"))
    }

    @Test
    fun failedBackgroundSaveLeavesThePreviewAlone() {
        val rendering = MapleState(rendering = true, loading = false, saving = true)

        val after = rendering.saveFailed(IOException("storage went away"))

        assertTrue(after.rendering)
        assertFalse(after.saving)
        assertTrue(after.error.orEmpty().startsWith("Could not save edits"))
    }
}
