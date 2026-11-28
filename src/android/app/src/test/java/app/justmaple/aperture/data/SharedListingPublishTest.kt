package app.justmaple.aperture.data

import app.justmaple.aperture.data.CountingTree.Companion.AUTHORITY
import app.justmaple.aperture.data.CountingTree.Companion.directory
import app.justmaple.aperture.data.CountingTree.Companion.folder
import app.justmaple.aperture.data.CountingTree.Companion.listed
import java.io.File
import java.nio.file.Files
import java.util.concurrent.atomic.AtomicLong
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

/** A shared listing may be a second old; a derivative is made visible only after a listing taken for that decision. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36], shadows = [DescriptorOs::class])
class SharedListingPublishTest {
    private val now = AtomicLong(1_000_000)
    private val tier = SharedCacheTier.Thumbnail
    private lateinit var library: PhotoLibrary
    private lateinit var documents: CacheDocuments
    private lateinit var photo: Photo
    private lateinit var thumbs: File

    @Before
    fun setUp() {
        directory = Files.createTempDirectory("shared-publish").toFile()
        Robolectric.setupContentProvider(CountingTree::class.java, AUTHORITY)
        CountingTree.supportsRename = true
        File(directory, "frame-1.dng").writeBytes(ByteArray(8))
        directory.listFiles()!!.forEach { it.setLastModified(System.currentTimeMillis() - 60_000) }
        thumbs = File(directory, ".maple/thumbs").apply { mkdirs() }
        library = PhotoLibrary(RuntimeEnvironment.getApplication()) { now.get() }
        documents = CacheDocuments(RuntimeEnvironment.getApplication(), library.local)
        photo = runBlocking { library.list(folder) }.photos.single()
        listed.clear()
    }

    @After
    fun tearDown() {
        CountingTree.resetFlags()
        directory.deleteRecursively()
    }

    private fun otherAppCreatesTheSidecar() {
        File(directory, "frame-1.xmp").writeBytes(XmpEncoding.encode(XmpDocument().serialize()))
        File(directory, "frame-1.xmp").setLastModified(System.currentTimeMillis() - 30_000)
    }

    private fun photoFolderListings() = listed["root"]?.get() ?: 0

    private fun publish(source: FolderCacheSource) = runBlocking {
        documents.publish(source, tier, ByteArray(32) { 7 }.inputStream(), null) { fresh ->
            library.folderCacheSource(photo, fresh)
        }
    }

    @Test
    fun aSidecarAnotherAppCreatesWhileTheListingIsSharedStopsThePublication() {
        val source = runBlocking { library.folderCacheSource(photo) }
        assertNull(source.sidecar)
        otherAppCreatesTheSidecar()
        assertNull("the shared listing is still a second old", runBlocking { library.folderCacheSource(photo) }.sidecar)

        val published = publish(source)

        assertNull(published)
        assertEquals("no derivative is left in the cache folder", emptyList<String>(), thumbs.list()!!.toList())
    }

    @Test
    fun theRetryAfterThatSeesTheSidecarAtOnce() {
        val source = runBlocking { library.folderCacheSource(photo) }
        otherAppCreatesTheSidecar()
        publish(source)

        val retry = runBlocking { library.folderCacheSource(photo) }

        assertNotNull("the guard's listing replaced the stale shared one", retry.sidecar)
        assertNotNull(retry.xml)
    }

    @Test
    fun anUnchangedSourceIsPublishedAfterThreeListingsOfThePhotoFolder() {
        val source = runBlocking { library.folderCacheSource(photo) }
        listed.clear()

        val published = publish(source)

        assertNotNull(published)
        assertTrue(File(thumbs, tier.filename(photo.name)).isFile)
        println("one publish, provider listings of the photo folder: ${photoFolderListings()}")
        assertEquals("the cache folder's own lookup plus one fresh listing before and one after the derivative is visible", 3, photoFolderListings())
    }

    @Test
    fun lookupsKeepUsingTheSharedListingWhateverAnotherAppDid() {
        val before = runBlocking { library.folderCacheSource(photo) }
        otherAppCreatesTheSidecar()
        listed.clear()
        val cache = FolderDerivativeCache(RuntimeEnvironment.getApplication(), library.local)

        repeat(5) {
            val refused = assertThrows(IllegalStateException::class.java) {
                runBlocking { cache.load(512, { fresh -> library.folderCacheSource(photo, fresh) }) { _, _, _ -> error("no render") } }
            }
            assertEquals("no render", refused.message)
        }

        assertEquals("lookups never list the photo folder again", 0, photoFolderListings())
        assertNull(before.sidecar)
    }

    @Test
    fun aRenderThatMissedAnotherAppsSidecarIsNotPublishedAndTheSecondRenderSeesIt() {
        val cache = FolderDerivativeCache(RuntimeEnvironment.getApplication(), library.local)
        val renders = mutableListOf<FolderCacheSource>()

        val stopped = assertThrows(IllegalStateException::class.java) {
            runBlocking {
                cache.load(512, { fresh -> library.folderCacheSource(photo, fresh) }) { source, target, _ ->
                    renders += source
                    check(renders.size == 1) { "second render" }
                    otherAppCreatesTheSidecar()
                    target.writeBytes(ByteArray(32) { 7 })
                }
            }
        }

        assertEquals("second render", stopped.message)
        assertNull(renders[0].sidecar)
        assertNotNull(renders[1].sidecar)
        assertEquals(emptyList<String>(), thumbs.list()!!.toList())
    }
}
