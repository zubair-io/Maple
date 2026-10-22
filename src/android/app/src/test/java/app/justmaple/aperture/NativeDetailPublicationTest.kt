package app.justmaple.aperture

import android.graphics.Bitmap
import android.net.Uri
import android.view.Surface
import app.justmaple.aperture.data.*
import app.justmaple.aperture.ui.CropRect
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
class NativeDetailPublicationTest {
    private class Renderer : PreviewRenderer {
        override val hasPresented = true
        override var revision = 0
        val calls = mutableListOf<Pair<NativeDetailRequest, CompletableDeferred<Bitmap>>>()
        override fun invalidateDraws() = ++revision
        override fun invalidateModel() {}
        override suspend fun open(path: String, document: String, edge: Int, generation: Int) = mapOf("exposure" to 0f)
        override suspend fun autoWhiteBalance(document: String): WhiteBalanceRecommendation = error("Unexpected WB")
        override suspend fun nativeDimensions(photo: Photo) = NativeImageSize(6000, 4000)
        override fun presentationSize(size: NativeImageSize, crop: CropRect) = size
        override suspend fun nativeDetail(request: NativeDetailRequest): Bitmap {
            val result = CompletableDeferred<Bitmap>()
            calls += request to result
            // Deliberately model JNI that finishes after coroutine cancellation.
            return withContext(NonCancellable) { result.await() }
        }
        override fun cancelNativeDetail() {}
        override fun recordSurface(next: Surface?, w: Int, h: Int, wideColor: Boolean) =
            EditorRenderer.SurfaceBinding(next, w, h, wideColor)
        override suspend fun attach(binding: EditorRenderer.SurfaceBinding) {}
        override suspend fun draw(next: Map<String, Float>, expectedRevision: Int, xml: String) {}
        override suspend fun refine(expectedRevision: Int) {}
        override suspend fun shutdown() {}
        override fun close() {}
    }

    @Test fun oldEditsAndNavigationCannotPublishLateNativePixelsAndMarginReusesCurrentPixels() = runBlocking {
        val main = UnconfinedTestDispatcher()
        Dispatchers.setMain(main)
        val app = RuntimeEnvironment.getApplication()
        val raw = File.createTempFile("detail-publication-", ".dng", app.cacheDir).apply { writeText("JNI fixture seam") }
        val bytes = raw.readBytes()
        val photo = Photo(Uri.fromFile(raw), raw.name, raw.length(), raw.lastModified(), null)
        val library = PhotoLibrary(app)
        library.save(photo, XmpDocument().withAttribute("xmp:Label", "retain foreign metadata"), null)
        val renderer = Renderer()
        val model = MapleViewModel(app, library, renderer)
        fun begin() {
            model.requestNativeDetail(NativeRegion(2500, 1600, 1000, 750))
            main.scheduler.advanceTimeBy(151)
            main.scheduler.runCurrent()
        }
        try {
            model.open(photo)
            withTimeout(10_000) { model.state.first { it.documentLoaded && !it.loading } }
            model.edit()
            withTimeout(10_000) { model.state.first { it.values.isNotEmpty() && it.nativeImageSize != null } }
            begin()
            assertEquals(1, renderer.calls.size)
            model.setField("exposure", 1f)
            val stale = Bitmap.createBitmap(10, 10, Bitmap.Config.ARGB_8888)
            renderer.calls[0].second.complete(stale)
            main.scheduler.runCurrent()
            assertNull(model.state.value.nativeDetail)
            begin()
            val fresh = Bitmap.createBitmap(10, 10, Bitmap.Config.ARGB_8888)
            renderer.calls[1].second.complete(fresh)
            main.scheduler.runCurrent()
            assertSame(fresh, model.state.value.nativeDetail?.bitmap)
            model.requestNativeDetail(NativeRegion(2510, 1610, 1000, 750))
            main.scheduler.advanceTimeBy(200)
            assertEquals("Pan within retained margin must reuse source pixels", 2, renderer.calls.size)
            val surfaceRevision = model.state.value.nativeSurfaceRevision
            model.surface(null, 1000, 750, wideColor = true)
            assertNull("A display target change retires the previous native frame", model.state.value.nativeDetail)
            assertEquals(surfaceRevision + 1, model.state.value.nativeSurfaceRevision)
            begin()
            assertEquals("Same region needs fresh pixels for the new display target", 3, renderer.calls.size)
            renderer.calls[2].second.complete(Bitmap.createBitmap(10, 10, Bitmap.Config.ARGB_8888))
            main.scheduler.runCurrent()
            model.requestNativeDetail(NativeRegion(4000, 2000, 1000, 750))
            main.scheduler.advanceTimeBy(151)
            main.scheduler.runCurrent()
            assertEquals(4, renderer.calls.size)
            model.back()
            withTimeout(10_000) { model.state.first { it.mode == PhotoMode.Preview } }
            renderer.calls[3].second.complete(Bitmap.createBitmap(10, 10, Bitmap.Config.ARGB_8888))
            main.scheduler.runCurrent()
            assertNull(model.state.value.nativeDetail)
            assertFalse(model.state.value.nativeDetailBusy)
            assertArrayEquals(bytes, raw.readBytes())
            assertTrue(model.flush())
            assertEquals("retain foreign metadata", library.loadSidecar(photo).document.attribute("xmp:Label"))
        } finally {
            renderer.calls.forEach { it.second.complete(Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888)) }
            raw.delete()
            Dispatchers.resetMain()
        }
    }
}
