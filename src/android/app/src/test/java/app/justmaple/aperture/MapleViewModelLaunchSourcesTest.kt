package app.justmaple.aperture

import android.net.Uri
import android.os.Looper
import android.view.Surface
import app.justmaple.aperture.data.*
import java.io.File
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
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

@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class MapleViewModelLaunchSourcesTest {
    private class IdleRenderer : PreviewRenderer {
        override val hasPresented = false
        override var revision = 0
        override fun invalidateDraws() = ++revision
        override fun invalidateModel() {}
        override suspend fun open(path: String, document: String, edge: Int, generation: Int) = emptyMap<String, Float>()
        override suspend fun modelValues(document: String): Map<String, Float> = error("Not requested")
        override suspend fun autoWhiteBalance(document: String): WhiteBalanceRecommendation = error("Not requested")
        override suspend fun sampleMaskRange(document: String, x: Float, y: Float): String = error("Not requested")
        override suspend fun nativeDimensions(photo: Photo): NativeImageSize? = null
        override suspend fun nativeDetail(request: NativeDetailRequest): android.graphics.Bitmap = error("Not requested")
        override fun cancelNativeDetail() {}
        override fun recordSurface(next: Surface?, w: Int, h: Int, wideColor: Boolean) =
            EditorRenderer.SurfaceBinding(next, w, h, wideColor)
        override suspend fun attach(binding: EditorRenderer.SurfaceBinding) {}
        override suspend fun draw(next: Map<String, Float>, expectedRevision: Int, xml: String) {}
        override suspend fun refine(expectedRevision: Int) {}
        override suspend fun shutdown() {}
        override fun close() {}
    }

    private val folders =
        listOf(
            Folder(Uri.parse("content://com.example.docs/tree/a"), "Alpha"),
            Folder(Uri.parse("content://com.example.docs/tree/b"), "Beta"),
        )

    @Before
    fun setUp() = Dispatchers.setMain(UnconfinedTestDispatcher())

    @After
    fun tearDown() = Dispatchers.resetMain()

    private fun MapleViewModel.await(what: String, predicate: (MapleState) -> Boolean): MapleState =
        runBlocking { withTimeout(10_000) { state.first(predicate) } }.also { assertTrue(what, predicate(it)) }

    private fun model(launchSources: () -> List<Folder>): MapleViewModel {
        val application = RuntimeEnvironment.getApplication()
        return MapleViewModel(application, PhotoLibrary(application), IdleRenderer(), null, launchSources)
    }

    @Test
    fun sourcesAreEvaluatedOnceForALaunchOffTheMainThread() {
        val evaluations = AtomicInteger()
        val onMain = CopyOnWriteArrayList<Boolean>()
        val model =
            model {
                evaluations.incrementAndGet()
                onMain += Looper.myLooper() == Looper.getMainLooper()
                folders
            }

        val loaded = model.await("the sources load") { !it.sourcesPending }
        model.await("the first browse starts from the same result") { it.folder == folders.first() }

        println("JVM host, unit level: library sources evaluated per launch: before 2 (initial state + first browse), after ${evaluations.get()}")
        assertEquals(1, evaluations.get())
        assertEquals(listOf(false), onMain.toList())
        assertEquals(folders, loaded.sources)
    }

    @Test
    fun loadedStateEqualsWhatTheStoredSourcesProduceDirectly() {
        val application = RuntimeEnvironment.getApplication()
        application
            .getSharedPreferences("maple-library", android.content.Context.MODE_PRIVATE)
            .edit()
            .putStringSet("sources", setOf("content://com.example.docs/tree/zeta", "content://com.example.docs/tree/alpha"))
            .commit()
        val library = PhotoLibrary(application)
        val expected = library.sources
        assertEquals(2, expected.size)

        val model = MapleViewModel(application, library, IdleRenderer())
        val loaded = model.await("the sources load") { !it.sourcesPending }

        assertEquals(expected, loaded.sources)
        model.await("the first source is browsed") { it.folder == expected.first() }
    }

    @Test
    fun neverShowsTheNoFoldersStateWhenSourcesExist() {
        val release = CountDownLatch(1)
        val model = model { check(release.await(10, TimeUnit.SECONDS)); folders }
        val seen = CopyOnWriteArrayList<MapleState>()
        val collector = kotlinx.coroutines.CoroutineScope(Dispatchers.Unconfined).launch(start = CoroutineStart.UNDISPATCHED) { model.state.collect { seen += it } }

        assertTrue("the first state says the sources are not known yet", seen.first().sourcesPending)
        release.countDown()
        model.await("the sources load") { !it.sourcesPending && it.folder != null }
        collector.cancel()

        val flashed = seen.filter { !it.sourcesPending && it.sources.isEmpty() }
        assertTrue("states that claim there are no sources: ${flashed.size}", flashed.isEmpty())
        assertTrue(seen.filter { it.sourcesPending }.all { it.sources.isEmpty() && it.folder == null })
    }

    @Test
    fun anEmptyLibraryStopsBeingPendingSoTheEmptyStateCanShow() {
        val model = model { emptyList() }

        val loaded = model.await("the sources load") { !it.sourcesPending }

        assertTrue(loaded.sources.isEmpty())
        assertNull(loaded.folder)
    }

    @Test
    fun anIntentThatArrivesBeforeTheSourcesAreKnownIsHeldAndThenRuns() {
        val release = CountDownLatch(1)
        val photoFile = File(RuntimeEnvironment.getApplication().cacheDir, "launch-intent.jpg").apply { writeBytes(byteArrayOf(1, 2, 3)) }
        val model = model { check(release.await(10, TimeUnit.SECONDS)); folders }

        model.openSingle(Uri.fromFile(photoFile))
        assertNull("the intent waits for the sources", model.state.value.selected)
        release.countDown()

        val opened = model.await("the intent's photo opens after the sources load") { it.selected != null && !it.loading }
        assertEquals("launch-intent.jpg", opened.selected!!.name)
        assertNull("opening a single photo is not undone by the launch browse", opened.folder)
        assertFalse(opened.sourcesPending)
        assertEquals(folders, opened.sources)
    }

    @Test
    fun aSourceChangeDuringTheWindowIsNotOverwrittenByTheStaleLaunchRead() {
        val release = CountDownLatch(1)
        val model = model { check(release.await(10, TimeUnit.SECONDS)); folders }
        val application = RuntimeEnvironment.getApplication()
        application
            .getSharedPreferences("maple-library", android.content.Context.MODE_PRIVATE)
            .edit().putStringSet("sources", emptySet()).commit()

        model.disconnectCloud(Folder(Uri.parse("maple-cloud://none"), "None"))
        model.await("a mutation computed fresh sources") { !it.sourcesPending }
        val photoFile = File(RuntimeEnvironment.getApplication().cacheDir, "stale-read.jpg").apply { writeBytes(byteArrayOf(1, 2, 3)) }
        model.openSingle(Uri.fromFile(photoFile))
        release.countDown()

        // openSingle runs only once the launch read has landed or been dropped.
        val settled = model.await("the launch read is settled") { it.selected != null && !it.loading }

        assertTrue("the stale launch read must not replace the fresher sources", settled.sources.isEmpty())
    }

    @Test
    fun aPhotoOpenedBeforeTheLaunchReadReturnsIsNotReplacedByTheFirstBrowse() {
        val release = CountDownLatch(1)
        val model = model { check(release.await(10, TimeUnit.SECONDS)); folders }
        val photo = Photo(Uri.parse("file:///photos/early.dng"), "early.dng", 1, 1, null)

        model.open(photo)
        assertNull("the open waits for the launch read, as it ran after the launch browse on main", model.state.value.selected)
        release.countDown()

        val settled = model.await("the opened photo wins over the first browse") {
            !it.loading && it.selected == photo && it.folder == folders.first()
        }
        assertEquals(PhotoMode.Preview, settled.mode)
    }

    @Test
    fun aFolderBrowsedBeforeTheLaunchReadReturnsWinsOverTheFirstSource() {
        val release = CountDownLatch(1)
        val model = model { check(release.await(10, TimeUnit.SECONDS)); folders }

        model.browse(folders[1])
        assertNull("the browse waits for the launch read", model.state.value.folder)
        release.countDown()

        model.await("the caller's folder wins") { !it.sourcesPending && !it.loading && it.folder == folders[1] }
    }
}
