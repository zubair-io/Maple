package app.justmaple.aperture.data

import app.justmaple.aperture.cloud.CloudLibrary
import java.io.File
import java.io.RandomAccessFile
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config

/** Cloud tiles as the app loads them: through [PhotoLibrary], its saves and its thumbnail budget. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class CloudTileLibraryTest {
    private val server = CloudTileServer()
    private val context = RuntimeEnvironment.getApplication()
    private var conversions = 0

    @After fun stop() = server.close()

    private fun library(sdk: Int = 36, convert: (java.io.FileInputStream, String) -> Unit = { _, _ -> error("AVIF is shown as is") }) =
        PhotoLibrary(context, { 0L }, CloudLibrary(context) { server.http }) { http, folder ->
            CloudDerivativeCache(http, folder, convert, sdk)
        }

    private fun PhotoLibrary.tile(photo: Photo, edge: Int = 512) =
        runBlocking { withThumbnail(photo, edge) { _, input -> input.readBytes() } }

    @Test
    fun aTileOfAPhotoThisAppSavedAsksTheServerEvenWhenTheListingsTokenIsUnchanged() {
        val library = library()
        val photo = server.photo("own-edit.dng", token = "k3j9x")
        library.tile(photo)
        library.tile(photo)
        assertEquals("an untouched photo with the listing's token needs no request", 1, server.thumbnailRequests.size)

        runBlocking { library.save(photo, XmpDocument().withAttribute("xmp:Rating", "4"), null) }
        val after = library.tile(photo)

        assertArrayEquals(server.thumbnail, after)
        assertEquals(2, server.thumbnailRequests.size)
        assertFalse("the stale token is not offered for the edited photo", server.thumbnailRequests.last().contains("?v="))
    }

    @Test
    fun aSaveThatReachedTheServerButFailedStillMakesTheNextTileAsk() {
        val library = library()
        val photo = server.photo("lost-reply.dng", token = "k3j9x")
        library.tile(photo)
        server.failSaves = true

        assertThrows(Exception::class.java) {
            runBlocking { library.save(photo, XmpDocument().withAttribute("xmp:Rating", "4"), null) }
        }
        server.failSaves = false
        library.tile(photo)

        assertEquals("the write was sent", 1, server.savesReceived.get())
        assertEquals("the tile asked although the listing's token is unchanged", 2, server.thumbnailRequests.size)
        assertFalse(server.thumbnailRequests.last().contains("?v="))
    }

    @Test
    fun aTileOfAnotherPhotoKeepsSkippingTheRequestAfterASave() {
        val library = library()
        val edited = server.photo("edited.dng", token = "a1")
        val untouched = server.photo("untouched.dng", token = "b2")
        library.tile(untouched)

        runBlocking { library.save(edited, XmpDocument().withAttribute("xmp:Rating", "4"), null) }
        library.tile(untouched)

        assertEquals(1, server.thumbnailRequests.size)
    }

    @Test
    fun aFailedPngConversionStillTrimsTheCacheAndTheTileFallsBackToTheOriginalBasedThumbnail() {
        val thumbnails = File(context.cacheDir, "thumbnails").apply { mkdirs() }
        val library =
            library(sdk = 30) { _, _ ->
                conversions++
                error("the shared core refused the AVIF")
            }
        val photo = server.photo("convert-fails.dng")
        val fallbackName = "${PhotoLibrary.digestParts("android-thumb-v4:${photo.key}:512:", "")}.jpg"
        val fallback = File(thumbnails, fallbackName).apply { writeBytes(byteArrayOf(1, 2, 3)) }
        val evictable =
            File(thumbnails, "stale-entry.bin").apply {
                RandomAccessFile(this, "rw").use { it.setLength(PhotoLibrary.THUMBNAIL_BYTES + 1) }
                setLastModified(System.currentTimeMillis() - 3_600_000)
            }

        val shown = library.tile(photo)

        assertEquals(1, conversions)
        assertArrayEquals(byteArrayOf(1, 2, 3), shown)
        assertTrue("the fallback tile survives", fallback.isFile)
        assertFalse("the inserted entry was accounted, so the budget was enforced", evictable.exists())
        assertTrue("the cached AVIF itself is kept for the next view", thumbnails.listFiles().orEmpty().any { it.name.endsWith(".avif") })
    }

    @Test
    fun aGridTileOnAndroid10And11IsTheThumbnailRoutesPngAndNeverTheOriginal() {
        val png = byteArrayOf(9, 8, 7)
        val library = library(sdk = 29) { _, destination -> File(destination).writeBytes(png) }
        val photo = server.photo("grid-tile.dng")

        val shown = library.tile(photo, 512)

        assertArrayEquals(png, shown)
        assertEquals(1, server.thumbnailRequests.size)
        assertEquals(emptyList<String>(), server.originalRequests)
    }

    @Test
    fun aFitTileOnAndroid10And11KeepsRenderingFromTheOriginalNotAConvertedPreview() {
        val library = library(sdk = 30) { _, _ -> conversions++ }
        val photo = server.photo("fit-tile.dng")

        runCatching { library.tile(photo, 2048) }

        assertEquals("the original is downloaded as before", 1, server.originalRequests.size)
        assertEquals("no preview or thumbnail is fetched for it", emptyList<String>(), server.thumbnailRequests + server.previewRequests)
        assertEquals(0, conversions)
    }
}
