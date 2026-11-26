package app.justmaple.aperture.data

import app.justmaple.aperture.data.CountingTree.Companion.AUTHORITY
import app.justmaple.aperture.data.CountingTree.Companion.directory
import app.justmaple.aperture.data.CountingTree.Companion.folder
import app.justmaple.aperture.data.CountingTree.Companion.listings
import app.justmaple.aperture.data.CountingTree.Companion.opens
import java.io.File
import java.nio.file.Files
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

@RunWith(RobolectricTestRunner::class)
class SidecarScanLockingTest {
    private lateinit var library: PhotoLibrary

    @Before
    fun setUp() {
        directory = Files.createTempDirectory("sidecar-scan").toFile()
        Robolectric.setupContentProvider(CountingTree::class.java, AUTHORITY)
        CountingTree.gate = null
        library = PhotoLibrary(RuntimeEnvironment.getApplication())
    }

    @After
    fun tearDown() {
        CountingTree.gate?.release?.countDown()
        directory.deleteRecursively()
    }

    private fun xmp(rating: Int) = XmpDocument().withAttribute("xmp:Rating", rating.toString()).serialize()

    private fun populate(count: Int, ratingOf: (Int) -> Int = { it % 6 }) {
        for (index in 1..count) {
            File(directory, "frame-${"%03d".format(index)}.dng").writeBytes(ByteArray(8))
            File(directory, "frame-${"%03d".format(index)}.xmp").writeBytes(XmpEncoding.encode(xmp(ratingOf(index))))
        }
        listings.set(0)
        opens.set(0)
    }

    private fun photos() = runBlocking { library.list(folder) }.photos.also { listings.set(0) }

    @Test
    fun aThumbnailSourceIsNotHeldUpWhileABadgeScanIsInTheMiddleOfAnotherPhotosRead() = runBlocking {
        populate(4)
        val photos = photos()
        val gate = CountingTree.Gate("frame-001.xmp").also { CountingTree.gate = it }
        val scan = async(Dispatchers.IO) { library.loadSidecars(photos) }
        assertTrue("the scan reached its first read", gate.entered.await(10, TimeUnit.SECONDS))

        val source = withTimeout(5_000) { library.folderCacheSource(photos[1]) }

        assertEquals("frame-002.dng", source.photo.name)
        assertEquals(xmp(2), source.xml)
        gate.release.countDown()
        assertEquals(4, scan.await().size)
    }

    @Test
    fun aSaveStillExcludesAReadOfTheSameSidecar() = runBlocking {
        populate(3)
        val photos = photos()
        val photo = photos.first()
        val baseline = library.loadSidecar(photo).baseline
        val gate = CountingTree.Gate("frame-001.xmp").also { CountingTree.gate = it }
        val save = async(Dispatchers.IO) { library.save(photo, XmpDocument(baseline!!).withAttribute("xmp:Rating", "5"), baseline) }
        assertTrue("the save is inside its first read", gate.entered.await(10, TimeUnit.SECONDS))
        val opensBefore = opens.get()

        val read = async(Dispatchers.IO) { library.loadSidecars(listOf(photo)) }
        val leaked = withContext(Dispatchers.IO) {
            val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2)
            while (opens.get() == opensBefore && System.nanoTime() < deadline) Thread.sleep(5)
            opens.get() != opensBefore
        }
        gate.release.countDown()
        save.await()

        assertFalse("a read opened the sidecar while the save held the lock", leaked)
        assertEquals("the read ran after the save and saw it whole", 5, read.await().getValue(photo.uri.toString()).document.rating)
    }

    @Test
    fun theScanReturnsTheSameMarksAsReadingEachSidecarOnItsOwn() = runBlocking {
        populate(6)
        File(directory, "frame-004.xmp").delete()
        val photos = photos()

        val scanned = library.loadSidecars(photos)

        assertEquals(photos.map { it.uri.toString() }.toSet(), scanned.keys)
        for (photo in photos) {
            val alone = library.loadSidecar(photo)
            val together = scanned.getValue(photo.uri.toString())
            assertEquals(photo.name, alone.baseline, together.baseline)
            assertEquals(photo.name, alone.document.rating, together.document.rating)
        }
        assertNull(scanned.getValue(photos[3].uri.toString()).baseline)
        assertEquals(0, scanned.getValue(photos[3].uri.toString()).document.rating)
        assertEquals(2, scanned.getValue(photos[1].uri.toString()).document.rating)
    }

    @Test
    fun aFiveHundredPhotoFolderIsListedOnceAndReadOncePerSidecar() = runBlocking {
        populate(500)
        val photos = photos()

        val scanned = library.loadSidecars(photos)

        println(
            "JVM host, unit level, 500-photo folder, first scan: folder listings ${listings.get()}, sidecar reads ${opens.get()}, " +
                "lock acquisitions ${listings.get() + opens.get()} (before the change: 1 + 500 exclusive; now the same count, all shared)"
        )
        assertEquals(500, scanned.size)
        assertEquals(1, listings.get())
        assertEquals(500, opens.get())
    }

    @Test
    fun aSaveThroughTheHiddenJpegIsSeenByTheFoldedRaw() = runBlocking {
        File(directory, "IMG_1.CR3").writeBytes(ByteArray(8))
        File(directory, "IMG_1.jpg").writeBytes(ByteArray(8))
        val sidecar = File(directory, "IMG_1.xmp").apply { writeBytes(XmpEncoding.encode(xmp(3))) }
        directory.listFiles()!!.forEach { it.setLastModified(System.currentTimeMillis() - 60_000) }
        val raw = library.list(folder).photos.single()
        val jpeg = requireNotNull(raw.companion)
        val stamps = HashMap<String, SidecarStamp?>()
        val ratings = HashMap<String, Int>()
        suspend fun scan() =
            library.scanSidecars(listOf(raw), { stamps[it.uri.toString()] }) { photo, scanned ->
                stamps[photo.uri.toString()] = scanned.stamp
                ratings[photo.uri.toString()] = scanned.loaded!!.document.rating
            }
        scan()
        val oldTime = sidecar.lastModified()
        val baseline = library.loadSidecar(jpeg).baseline!!

        library.save(jpeg, XmpDocument(baseline).withAttribute("xmp:Rating", "4"), baseline)
        File(directory, "IMG_1.xmp").setLastModified(oldTime)
        scan()

        assertEquals(4, ratings.getValue(raw.uri.toString()))
    }

    @Test
    fun openingAPhotoReadsItsSidecarWhileABadgeScanIsMidRead() = runBlocking {
        populate(4)
        val photos = photos()
        val gate = CountingTree.Gate("frame-001.xmp").also { CountingTree.gate = it }
        val scan = async(Dispatchers.IO) { library.loadSidecars(photos) }
        assertTrue(gate.entered.await(10, TimeUnit.SECONDS))

        val opened = withTimeout(5_000) { library.loadSidecar(photos[2]) }

        assertEquals(3, opened.document.rating)
        gate.release.countDown()
        scan.await()
        Unit
    }
}
