package app.justmaple.aperture

import android.net.Uri
import android.view.Surface
import app.justmaple.aperture.data.*
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

/** Disconnecting a server closes its photo even when Search opened it outside the browsed source. */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class CloudDisconnectTest {
    private class IdleRenderer : PreviewRenderer {
        var shutdowns = 0
        override val hasPresented = false
        override var revision = 0
        override fun invalidateDraws() = ++revision
        override fun invalidateModel() {}
        override suspend fun open(path: String, document: String, edge: Int, generation: Int) = emptyMap<String, Float>()
        override suspend fun modelValues(document: String): Map<String, Float> = error("Not requested")
        override suspend fun autoWhiteBalance(document: String): WhiteBalanceRecommendation = error("Not requested")
        override suspend fun sampleMaskRange(document: String, x: Float, y: Float): String = error("Not requested")
        override suspend fun nativeDimensions(photo: Photo): app.justmaple.aperture.data.NativeImageSize? = null
        override suspend fun nativeDetail(request: app.justmaple.aperture.data.NativeDetailRequest): android.graphics.Bitmap =
            error("Not requested")
        override fun cancelNativeDetail() {}
        override fun recordSurface(next: Surface?, w: Int, h: Int, wideColor: Boolean) =
            EditorRenderer.SurfaceBinding(next, w, h, wideColor)
        override suspend fun attach(binding: EditorRenderer.SurfaceBinding) {}
        override suspend fun draw(next: Map<String, Float>, expectedRevision: Int, xml: String) {}
        override suspend fun refine(expectedRevision: Int) {}
        override suspend fun shutdown() {
            ++shutdowns
        }
        override fun close() {}
    }

    private val renderer = IdleRenderer()
    private lateinit var model: MapleViewModel

    private fun await(what: String, predicate: (MapleState) -> Boolean): MapleState =
        runBlocking { withTimeout(10_000) { model.state.first(predicate) } }.also { assertTrue(what, predicate(it)) }

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        val application = RuntimeEnvironment.getApplication()
        model = MapleViewModel(application, PhotoLibrary(application), renderer)
    }

    @After
    fun tearDown() = Dispatchers.resetMain()

    @Test
    fun disconnectingTheServerOfAPhotoOpenedFromSearchClosesIt() {
        val server = Uri.parse("maple-cloud://0f3c2c1e-4a5b-4c6d-8e9f-0a1b2c3d4e5f")
        val photo = Photo(server.buildUpon().appendQueryParameter("address", "photos:2026/a.dng").build(), "a.dng", 1, 1, null)
        // No folder of that server is browsed: the photo came from its search results.
        model.openFromBrowse(photo, listOf(photo))
        await("the search result opens") { it.selected == photo && !it.loading }
        val opened = renderer.shutdowns

        model.disconnectCloud(Folder(server, "Studio"))
        val closed = await("the disconnected server's photo closes") { it.selected == null }
        assertEquals(PhotoMode.Browse, closed.mode)
        assertNull(closed.previewOrder)
        assertTrue("Its renderer is shut down", renderer.shutdowns > opened)
    }
}
