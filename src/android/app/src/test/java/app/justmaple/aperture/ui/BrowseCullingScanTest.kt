package app.justmaple.aperture.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.junit4.createComposeRule
import app.justmaple.aperture.data.CountingTree
import app.justmaple.aperture.data.CountingTree.Companion.AUTHORITY
import app.justmaple.aperture.data.CountingTree.Companion.directory
import app.justmaple.aperture.data.CountingTree.Companion.folder
import app.justmaple.aperture.data.CountingTree.Companion.listings
import app.justmaple.aperture.data.CountingTree.Companion.opens
import app.justmaple.aperture.data.Photo
import app.justmaple.aperture.data.PhotoLibrary
import app.justmaple.aperture.data.XmpDocument
import app.justmaple.aperture.data.XmpEncoding
import java.io.File
import java.nio.file.Files
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class BrowseCullingScanTest {
    @get:Rule val compose = createComposeRule()
    private lateinit var library: PhotoLibrary
    private lateinit var scan: BrowseCullingScan
    private lateinit var photos: List<Photo>

    private fun xmp(rating: Int) = XmpDocument().withAttribute("xmp:Rating", rating.toString()).serialize()

    @Before
    fun setUp() {
        directory = Files.createTempDirectory("culling-scan").toFile()
        Robolectric.setupContentProvider(CountingTree::class.java, AUTHORITY)
        CountingTree.gate = null
        for (index in 1..500) {
            val name = "frame-${"%03d".format(index)}"
            File(directory, "$name.dng").writeBytes(ByteArray(8))
            File(directory, "$name.xmp").writeBytes(XmpEncoding.encode(xmp(index % 6)))
        }
        CountingTree.reportsModified = true
        directory.listFiles()!!.forEach { it.setLastModified(System.currentTimeMillis() - 60_000) }
        library = PhotoLibrary(RuntimeEnvironment.getApplication())
        scan = BrowseCullingScan(library)
        photos = runBlocking { library.list(folder) }.photos
        listings.set(0)
        opens.set(0)
    }

    @After
    fun tearDown() {
        directory.deleteRecursively()
    }

    private fun rating(photo: Photo, marks: Map<String, PhotoCulling>) = marks.getValue(photo.uri.toString()).rating

    @Test
    fun aSecondScanOfTheSameFolderReadsNoSidecarAndReturnsTheSameMarks() = runBlocking {
        val first = scan.scan(photos)
        val readsOnFirst = opens.get()
        val second = scan.scan(photos)

        println(
            "JVM host, unit level, 500 photos: first scan listings=1 reads=$readsOnFirst; " +
                "repeat scan (what a selection change or a return to the grid triggers) reads=${opens.get() - readsOnFirst} " +
                "(before the change: ${readsOnFirst} reads on every such repeat)"
        )
        assertEquals(500, readsOnFirst)
        assertEquals("no sidecar read again", 500, opens.get())
        assertEquals(first, second)
        assertEquals(3, rating(photos[2], second))
    }

    @Test
    fun aSidecarThatChangedOnDiskIsTheOnlyOneReadAgain() = runBlocking {
        scan.scan(photos)
        val file = File(directory, "frame-007.xmp")
        file.writeBytes(XmpEncoding.encode(xmp(5)))
        file.setLastModified(file.lastModified() + 10_000)
        val before = opens.get()

        val marks = scan.scan(photos)

        assertEquals(1, opens.get() - before)
        assertEquals(5, rating(photos[6], marks))
    }

    @Test
    fun aSaveFromThisAppIsReadAgainEvenWhenTheProvidersTimestampAndSizeDidNotMove() = runBlocking {
        scan.scan(photos)
        val photo = photos[2]
        val file = File(directory, "frame-003.xmp")
        val baseline = library.loadSidecar(photo).baseline!!
        val stamp = file.lastModified()
        library.save(photo, XmpDocument(baseline).withAttribute("xmp:Rating", "4"), baseline)
        file.setLastModified(stamp)
        val before = opens.get()

        val marks = scan.scan(photos)

        assertTrue("the saved sidecar was read again", opens.get() > before)
        assertEquals(4, rating(photo, marks))
    }

    @Test
    fun aPhotoWithoutASidecarShowsNoMarks() = runBlocking {
        File(directory, "frame-001.xmp").delete()

        val marks = scan.scan(photos)

        assertEquals(0, rating(photos[0], marks))
    }

    @Test
    fun aSelectionChangeInTheGridRelistsOnceAndReadsNothing() {
        var selected by mutableStateOf<Photo?>(null)
        var marks = emptyMap<String, PhotoCulling>()
        compose.setContent {
            marks = rememberBrowseCulling(scan, photos, selected, XmpDocument(), documentLoaded = false)
        }
        compose.waitUntil(20_000) { marks.size == 500 }
        val readsAfterFirstScan = opens.get()
        val listingsAfterFirstScan = listings.get()

        compose.runOnIdle { selected = photos[3] }
        compose.waitForIdle()
        compose.waitUntil(20_000) { listings.get() > listingsAfterFirstScan }

        assertEquals(500, readsAfterFirstScan)
        assertEquals("a selection change re-reads no sidecar", readsAfterFirstScan, opens.get())
        assertEquals(500, marks.size)
    }

    @Test
    fun theOpenPhotosLiveDocumentOverridesItsScannedMarkWithoutAnotherScan() {
        var document by mutableStateOf(XmpDocument())
        var marks = emptyMap<String, PhotoCulling>()
        compose.setContent {
            marks = rememberBrowseCulling(scan, photos, photos[4], document, documentLoaded = true)
        }
        compose.waitUntil(20_000) { marks.size == 500 }
        val reads = opens.get()
        val listed = listings.get()

        compose.runOnIdle { document = xmp(5).let(::XmpDocument) }
        compose.waitForIdle()

        assertEquals(5, rating(photos[4], marks))
        assertEquals(reads, opens.get())
        assertEquals("an edit of the open photo does not relist the folder", listed, listings.get())
    }

    @Test
    fun aProviderThatReportsNoModifiedTimeIsNeverReusedSoAnOutsideSameLengthRewriteIsSeen() = runBlocking {
        CountingTree.reportsModified = false
        scan.scan(photos)
        val file = File(directory, "frame-004.xmp")
        file.writeBytes(XmpEncoding.encode(xmp(5)))
        assertEquals("same length as the original rating 4", xmp(4).length, xmp(5).length)
        val before = opens.get()

        val marks = scan.scan(photos)

        assertEquals("every sidecar is read again", 500, opens.get() - before)
        assertEquals(5, rating(photos[3], marks))
    }

    @Test
    fun aSidecarModifiedJustNowIsReadAgainOnceItsTimestampIsOldEnoughThenReused() = runBlocking {
        val file = File(directory, "frame-009.xmp")
        file.setLastModified(System.currentTimeMillis())
        scan.scan(photos)
        val afterFirst = opens.get()

        scan.scan(photos)
        assertEquals("the fresh one is read again, the other 499 are reused", 1, opens.get() - afterFirst)

        file.setLastModified(System.currentTimeMillis() - 60_000)
        scan.scan(photos)
        assertEquals("read once more, now recorded as reusable", 2, opens.get() - afterFirst)

        scan.scan(photos)
        assertEquals("and then reused", 2, opens.get() - afterFirst)
    }
}
