package app.justmaple.aperture

import android.net.Uri
import android.view.Surface
import app.justmaple.aperture.data.*
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
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
 * "Discard unsaved edits" unblocks navigation without any I/O.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class MapleViewModelRecoveryTest {
    private class FlakySidecars : SidecarStore {
        var failing = false
        var saves = 0

        override suspend fun loadSidecar(photo: Photo): LoadedSidecar {
            if (failing) throw IOException("storage went away")
            return LoadedSidecar(XmpDocument(), XmpDocument.EMPTY)
        }

        override suspend fun save(photo: Photo, document: XmpDocument, baseline: String?): LoadedSidecar {
            saves++
            if (failing) throw IOException("storage went away")
            val xml = document.serialize()
            return LoadedSidecar(XmpDocument(xml), xml)
        }
    }

    private class IdleRenderer : PreviewRenderer {
        override val hasPresented = false
        override var revision = 0
        override fun invalidateDraws() = ++revision
        override suspend fun open(path: String, document: String, edge: Int, generation: Int) = emptyMap<String, Float>()
        override fun recordSurface(next: Surface?, w: Int, h: Int, wideColor: Boolean) =
            EditorRenderer.SurfaceBinding(next, w, h, wideColor)
        override suspend fun attach(binding: EditorRenderer.SurfaceBinding) {}
        override suspend fun draw(next: Map<String, Float>, expectedRevision: Int, xml: String) {}
        override suspend fun refine(expectedRevision: Int) {}
        override suspend fun shutdown() {}
        override fun close() {}
    }

    private val photo = Photo(Uri.parse("content://test/tree/photo.dng"), "photo.dng", 1, 1, null)
    private val sidecars = FlakySidecars()
    private lateinit var model: MapleViewModel

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        val application = RuntimeEnvironment.getApplication()
        model = MapleViewModel(application, PhotoLibrary(application), sidecars, IdleRenderer())
        model.open(photo)
        assertTrue(model.state.value.documentLoaded)
        model.attribute("xmp:Rating", "3")
        assertTrue(model.state.value.dirty)
        sidecars.failing = true
    }

    @After
    fun tearDown() = Dispatchers.resetMain()

    @Test
    fun failedReloadKeepsTheDocumentLoadedAndDirty() {
        model.reloadSavedEdits()

        val state = model.state.value
        assertTrue(state.documentLoaded)
        assertTrue(state.dirty)
        assertFalse(state.loading)
        assertEquals("3", state.document.attribute("xmp:Rating"))
        assertTrue(state.error.orEmpty().startsWith("Could not reload saved edits"))
    }

    @Test
    fun failedReloadThenFailedSave_IsRecoveredByDiscard() {
        model.reloadSavedEdits()

        model.back()
        assertEquals(PhotoMode.Preview, model.state.value.mode)
        assertTrue(model.state.value.error.orEmpty().startsWith("Could not save edits"))
        val savesBefore = sidecars.saves

        model.discardUnsavedEdits()
        val discarded = model.state.value
        assertFalse(discarded.dirty)
        assertTrue(discarded.documentLoaded)
        assertNull(discarded.error)
        assertNull(discarded.document.attribute("xmp:Rating"))
        assertEquals(savesBefore, sidecars.saves)

        model.back()
        assertEquals(PhotoMode.Browse, model.state.value.mode)
    }

    @Test
    fun discardIsANoOpWithoutUnsavedEdits() {
        model.discardUnsavedEdits()
        assertFalse(model.state.value.dirty)

        model.discardUnsavedEdits()
        assertTrue(model.state.value.documentLoaded)
        assertNull(model.state.value.error)
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
