package app.justmaple.aperture.data

import android.net.Uri
import android.provider.DocumentsContract
import app.justmaple.aperture.data.CountingTree.Companion.AUTHORITY
import app.justmaple.aperture.data.CountingTree.Companion.directory
import app.justmaple.aperture.data.CountingTree.Companion.failListings
import app.justmaple.aperture.data.CountingTree.Companion.folder
import app.justmaple.aperture.data.CountingTree.Companion.listings
import java.io.File
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/** Every tile of a view asks the folder for its siblings; one listing answers them all for a second. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class SharedFolderListingTest {
    private val now = AtomicLong(1_000_000)
    private lateinit var library: PhotoLibrary
    private lateinit var photos: List<Photo>

    @Before
    fun setUp() {
        directory = Files.createTempDirectory("shared-listing").toFile()
        Robolectric.setupContentProvider(CountingTree::class.java, AUTHORITY)
        CountingTree.gate = null
        CountingTree.reportsModified = true
        for (index in 1..6) {
            File(directory, "frame-$index.dng").writeBytes(ByteArray(8))
            File(directory, "frame-$index.xmp").writeBytes(XmpEncoding.encode(XmpDocument().serialize()))
        }
        directory.listFiles()!!.forEach { it.setLastModified(System.currentTimeMillis() - 60_000) }
        library = PhotoLibrary(RuntimeEnvironment.getApplication()) { now.get() }
        photos = runBlocking { library.list(folder) }.photos
        listings.set(0)
        CountingTree.listed.clear()
    }

    @After
    fun tearDown() {
        CountingTree.resetFlags()
        directory.deleteRecursively()
    }

    private fun subfolder(name: String): Uri {
        File(directory, name).mkdirs()
        return DocumentsContract.buildDocumentUriUsingTree(
            DocumentsContract.buildTreeDocumentUri(AUTHORITY, "root"),
            "root/$name",
        )
    }

    private fun awaitBlocked(thread: AtomicReference<Thread>) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
        while (thread.get()?.state != Thread.State.BLOCKED && System.nanoTime() < deadline) Thread.yield()
        assertEquals(Thread.State.BLOCKED, thread.get()?.state)
    }

    private fun LocalDocuments.recentWhileListing(target: Uri, meanwhile: () -> Unit): List<LocalDocument> {
        val gate = CountingTree.Gate(DocumentsContract.getDocumentId(target))
        CountingTree.listingGate = gate
        val pool = Executors.newSingleThreadExecutor()
        try {
            val listing = pool.submit<List<LocalDocument>> { recent(target) }
            assertTrue(gate.entered.await(10, TimeUnit.SECONDS))
            meanwhile()
            gate.release.countDown()
            return listing.get(10, TimeUnit.SECONDS)
        } finally {
            gate.release.countDown()
            pool.shutdownNow()
        }
    }

    private fun tiles(count: Int) = runBlocking {
        List(count) { index -> async(Dispatchers.IO) { library.folderCacheSource(photos[index % photos.size]) } }.awaitAll()
    }

    @Test
    fun manyConcurrentTileRequestsForOneFolderCauseOneListing() {
        val sources = tiles(24)

        println("24 concurrent tile requests: provider listings=${listings.get()} (before the change: 2 per request, 48)")
        assertEquals(1, listings.get())
        assertEquals(24, sources.size)
        assertEquals(photos.map { it.uri }.toSet(), sources.map { it.photo.uri }.toSet())
    }

    @Test
    fun theListingIsReusedForUnderASecondAndAskedAgainAfterIt() {
        tiles(1)
        now.addAndGet(999)
        tiles(5)
        assertEquals(1, listings.get())

        now.addAndGet(1)
        tiles(5)
        assertEquals(2, listings.get())
    }

    @Test
    fun aSaveByThisAppRefreshesTheListingAtOnce() {
        tiles(1)
        val photo = photos[2]
        val baseline = runBlocking { library.loadSidecar(photo) }.baseline
        val saved = runBlocking {
            library.save(photo, XmpDocument(baseline ?: XmpDocument.EMPTY).withAttribute("xmp:Rating", "4"), baseline)
        }
        val afterSave = listings.get()

        val source = runBlocking { library.folderCacheSource(photo) }

        assertEquals("the next tile lists again", afterSave + 1, listings.get())
        assertEquals(saved.baseline, source.xml)
        tiles(3)
        assertEquals("and the others share that listing", afterSave + 1, listings.get())
    }

    @Test
    fun invalidatingEveryFolderMakesTheNextRequestListAgain() {
        val documents = LocalDocuments(RuntimeEnvironment.getApplication()) { now.get() }
        documents.recent(folder)
        documents.recent(folder)
        assertEquals(1, listings.get())

        documents.invalidateAll()
        documents.recent(folder)

        assertEquals(2, listings.get())
    }

    @Test
    fun concurrentCallersOfOneFolderWaitForTheSingleListing() {
        val documents = LocalDocuments(RuntimeEnvironment.getApplication()) { now.get() }
        val pool = Executors.newFixedThreadPool(16)
        val start = CountDownLatch(1)
        try {
            val results = List(16) { pool.submit<Int> { start.await(); documents.recent(folder).size } }
            start.countDown()
            assertEquals(List(16) { 12 }, results.map { it.get() })
        } finally {
            pool.shutdownNow()
        }
        assertEquals(1, listings.get())
    }

    @Test
    fun refreshingAFolderListsItAgainForTheTilesThatFollow() {
        library.local.recent(folder)
        File(directory, "frame-7.dng").writeBytes(ByteArray(8))
        File(directory, "frame-7.dng").setLastModified(System.currentTimeMillis() - 60_000)

        val arrived = runBlocking { library.list(folder) }.photos.single { it.name == "frame-7.dng" }
        val source = runBlocking { library.folderCacheSource(arrived) }

        assertEquals(arrived.uri, source.photo.uri)
    }

    @Test
    fun refreshingAFolderShowsAReplacedPhotoAtOnce() {
        val replaced = photos.first()
        runBlocking { library.folderCacheSource(replaced) }
        File(directory, replaced.name).writeBytes(ByteArray(64))

        val current = runBlocking { library.list(folder) }.photos.first { it.name == replaced.name }
        val source = runBlocking { library.folderCacheSource(current) }

        assertEquals(64L, source.photo.size)
    }

    @Test
    fun aFewFoldersAreHeldAtOnceAndTheLeastRecentlyUsedIsDropped() {
        val documents = LocalDocuments(RuntimeEnvironment.getApplication()) { now.get() }
        val others = List(4) { subfolder("d$it") }
        documents.recent(folder)
        others.take(3).forEach { documents.recent(it) }
        documents.recent(folder)

        documents.recent(others[3])

        assertNull("the least recently used folder was dropped", documents.held(others[0]))
        listOf(folder, others[1], others[2], others[3]).forEach { assertNotNull(it.toString(), documents.held(it)) }
        val before = listings.get()
        documents.recent(folder)
        assertEquals("a folder still held is not listed again", before, listings.get())
        documents.recent(others[0])
        assertEquals("the dropped folder is", before + 1, listings.get())
    }

    @Test
    fun aListingOfOneFolderDoesNotBlockTheListingOfAnother() {
        val documents = LocalDocuments(RuntimeEnvironment.getApplication()) { now.get() }
        val slow = subfolder("slow")
        val blocked = CountingTree.Gate("root/slow")
        CountingTree.listingGate = blocked
        val pool = Executors.newFixedThreadPool(2)
        try {
            val waiting = pool.submit<Int> { documents.recent(slow).size }
            assertTrue(blocked.entered.await(10, TimeUnit.SECONDS))

            val listed = pool.submit<Int> { documents.recent(folder).size }

            assertEquals(13, listed.get(10, TimeUnit.SECONDS))
            blocked.release.countDown()
            assertEquals(0, waiting.get(10, TimeUnit.SECONDS))
        } finally {
            blocked.release.countDown()
            pool.shutdownNow()
        }
    }

    @Test
    fun aFailedListingFailsOnlyItsOwnCallerAndAWaiterListsForItself() {
        val documents = LocalDocuments(RuntimeEnvironment.getApplication()) { now.get() }
        val blocked = CountingTree.Gate("root")
        CountingTree.listingGate = blocked
        CountingTree.failNextListing.set(true)
        val pool = Executors.newFixedThreadPool(2)
        try {
            val failing = pool.submit<Int> { documents.recent(folder).size }
            assertTrue(blocked.entered.await(10, TimeUnit.SECONDS))
            val waiterThread = AtomicReference<Thread>()
            val waiter =
                pool.submit<Int> {
                    waiterThread.set(Thread.currentThread())
                    documents.recent(folder).size
                }
            awaitBlocked(waiterThread)
            blocked.release.countDown()

            assertTrue(assertThrows(ExecutionException::class.java) { failing.get(10, TimeUnit.SECONDS) }.cause is IllegalStateException)
            assertEquals(12, waiter.get(10, TimeUnit.SECONDS))
            assertNotNull("the waiter's own listing is held", documents.held(folder))
        } finally {
            blocked.release.countDown()
            pool.shutdownNow()
        }
    }

    @Test
    fun anInvalidationOfAnotherFolderDoesNotMakeTheWaitersListAgain() {
        val documents = LocalDocuments(RuntimeEnvironment.getApplication()) { now.get() }
        val other = subfolder("other")
        documents.recent(other)
        CountingTree.listed.clear()
        val blocked = CountingTree.Gate("root")
        CountingTree.listingGate = blocked
        val pool = Executors.newFixedThreadPool(9)
        try {
            val holder = pool.submit<Int> { documents.recent(folder).size }
            assertTrue(blocked.entered.await(10, TimeUnit.SECONDS))
            val threads = List(8) { AtomicReference<Thread>() }
            val waiters =
                threads.map { thread ->
                    pool.submit<Int> {
                        thread.set(Thread.currentThread())
                        documents.recent(folder).size
                    }
                }
            threads.forEach(::awaitBlocked)

            documents.invalidate(other)
            blocked.release.countDown()

            assertEquals(13, holder.get(10, TimeUnit.SECONDS))
            assertEquals(List(8) { 13 }, waiters.map { it.get(10, TimeUnit.SECONDS) })
            println("8 waiters, another folder invalidated meanwhile: provider listings of the folder=${CountingTree.listed["root"]?.get()}")
            assertEquals(1, CountingTree.listed["root"]?.get())
            assertNotNull(documents.held(folder))
        } finally {
            blocked.release.countDown()
            pool.shutdownNow()
        }
    }

    @Test
    fun tilesOfOneFolderListThePhotoFolderAndItsCacheFoldersOnceEach() {
        File(directory, ".maple/thumbs").mkdirs()
        val cache = FolderDerivativeCache(RuntimeEnvironment.getApplication(), library.local)

        photos.forEach { photo ->
            val refused = assertThrows(IllegalStateException::class.java) {
                runBlocking { cache.load(512, { library.folderCacheSource(photo) }) { _, _, _ -> error("no render") } }
            }
            assertEquals("no render", refused.message)
        }

        val counts = CountingTree.listed.toSortedMap().mapValues { it.value.get() }
        println("${photos.size} tile loads, provider listings by folder: $counts")
        assertEquals(
            mapOf("root" to 1, "root/.maple" to 1, "root/.maple/thumbs" to 1),
            counts,
        )
    }

    @Test
    fun anExpiredListingIsNotHeldWhenTheNextListingFails() {
        val documents = LocalDocuments(RuntimeEnvironment.getApplication()) { now.get() }
        documents.recent(folder)
        assertNotNull(documents.held(folder))
        now.addAndGet(1_000)
        failListings = true

        assertThrows(IllegalStateException::class.java) { documents.recent(folder) }

        assertNull(documents.held(folder))
    }

    @Test
    fun aListingTheSystemReclaimedIsListedAgain() {
        val documents = LocalDocuments(RuntimeEnvironment.getApplication()) { now.get() }
        documents.recent(folder)
        documents.held(folder)!!.entries.clear()
        val before = listings.get()

        assertEquals(12, documents.recent(folder).size)

        assertEquals(before + 1, listings.get())
        assertNotNull(documents.held(folder)!!.entries.get())
    }

    @Test
    fun aChangeToTheSameFolderLandingWhileItIsListedLeavesNothingHeld() {
        val documents = LocalDocuments(RuntimeEnvironment.getApplication()) { now.get() }

        val listed = documents.recentWhileListing(folder) { documents.invalidate(folder) }

        assertEquals(12, listed.size)
        assertNull(documents.held(folder))
        val before = listings.get()
        documents.recent(folder)
        assertEquals(before + 1, listings.get())
        assertNotNull(documents.held(folder))
    }

    @Test
    fun invalidatingEveryFolderWhileOneIsListedLeavesNothingHeld() {
        val documents = LocalDocuments(RuntimeEnvironment.getApplication()) { now.get() }

        documents.recentWhileListing(folder) { documents.invalidateAll() }

        assertNull(documents.held(folder))
    }

    @Test
    fun aListingThatTookLongerThanTheWindowIsNotServedAgain() {
        val documents = LocalDocuments(RuntimeEnvironment.getApplication()) { now.get() }

        documents.recentWhileListing(folder) { now.addAndGet(1_500) }
        val before = listings.get()
        documents.recent(folder)

        assertEquals("the window counts from when the listing began", before + 1, listings.get())
    }
}
