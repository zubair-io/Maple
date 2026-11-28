package app.justmaple.aperture.data

import app.justmaple.aperture.documents.CloudDocumentId
import app.justmaple.aperture.documents.CloudDocumentThumbnails
import app.justmaple.aperture.documents.CloudEntry
import app.justmaple.aperture.documents.CloudEntryKind
import java.io.File
import java.io.FileNotFoundException
import java.io.RandomAccessFile
import javax.imageio.ImageIO
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Android 10 and 11 cannot decode AVIF: a cloud tile there is the server's thumbnail as a private PNG, never the original. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class CloudThumbnailApiLevelTest {
    @get:Rule val temporary = TemporaryFolder()
    private val server = CloudTileServer()
    private var conversions = 0
    private var converted = emptyList<Byte>()

    @After fun stop() = server.close()

    private fun cache(sdk: Int, folder: File) =
        CloudDerivativeCache(
            server.http,
            folder,
            { source, destination ->
                conversions++
                converted += source.readBytes().toList()
                CloudTileServer.writePng(destination)
            },
            sdk,
        )

    private fun assertDerivativeServedInsteadOfOriginal(sdk: Int) {
        val derivatives = cache(sdk, temporary.newFolder())

        val tile = checkNotNull(derivatives.load(server.photo(), 512))
        val shown = tile.image.use { it.input.readBytes() }

        assertNotNull("the tile decodes as an image", ImageIO.read(shown.inputStream()))
        assertTrue(tile.image.file!!.name.endsWith(".png"))
        assertEquals(1, server.thumbnailRequests.size)
        assertEquals(emptyList<String>(), server.originalRequests)
        assertEquals(server.thumbnail.size.toLong(), server.thumbnailBytesServed)
        assertEquals(0L, server.originalBytesServed)
        assertEquals(1, conversions)
        assertEquals("the PNG is made from the server's thumbnail", server.thumbnail.toList(), converted)

        val again = checkNotNull(derivatives.load(server.photo(), 512))
        again.image.use { assertArrayEquals(shown, it.input.readBytes()) }
        assertEquals("the second view revalidates, it does not download again", server.thumbnail.size.toLong(), server.thumbnailBytesServed)
        assertEquals("the PNG is converted once", 1, conversions)
        assertEquals(2, server.thumbnailRequests.size)
    }

    @Test fun androidTenGetsTheDerivativeAsAPngAndNeverTheOriginal() = assertDerivativeServedInsteadOfOriginal(29)

    @Test fun androidElevenGetsTheDerivativeAsAPngAndNeverTheOriginal() = assertDerivativeServedInsteadOfOriginal(30)

    @Test
    fun androidTwelveAndLaterKeepTheAvifWithoutConverting() {
        val tile = checkNotNull(cache(31, temporary.newFolder()).load(server.photo(), 512))

        val shown = tile.image.use { it.input.readBytes() }

        assertArrayEquals(server.thumbnail, shown)
        assertEquals(0, conversions)
    }

    @Test
    fun theDocumentsProviderOnAndroidElevenServesTheSamePngWithoutTheOriginal() {
        val folder = temporary.newFolder()
        val thumbnails = CloudDocumentThumbnails(cache(30, folder), folder)
        val document = CloudDocumentId(server.id, false, "library-id", "lib", "2026/a.dng")
        val entry = CloudEntry("2026/a.dng", CloudEntryKind.Photo, server.original.size.toLong(), 1_700_000_000_000L, true)

        val served = thumbnails.open(document, entry, null).createInputStream().use { it.readBytes() }

        assertNotNull("the provider's thumbnail decodes as an image", ImageIO.read(served.inputStream()))
        assertEquals(emptyList<String>(), server.originalRequests)
        assertEquals(server.thumbnail.size.toLong(), server.thumbnailBytesServed)
        assertEquals(0L, server.originalBytesServed)
        assertEquals(1, conversions)
    }

    @Test
    fun theDocumentsProviderAnswersNotFoundWhenThePngConversionFailsAndStillEnforcesTheBudget() {
        val folder = temporary.newFolder()
        val derivatives = CloudDerivativeCache(server.http, folder, { _, _ -> error("the shared core refused the AVIF") }, 30)
        val evictable =
            File(folder, "stale-entry.bin").apply {
                RandomAccessFile(this, "rw").use { it.setLength(PhotoLibrary.THUMBNAIL_BYTES + 1) }
                setLastModified(System.currentTimeMillis() - 3_600_000)
            }
        val document = CloudDocumentId(server.id, false, "library-id", "lib", "2026/a.dng")
        val entry = CloudEntry("2026/a.dng", CloudEntryKind.Photo, server.original.size.toLong(), 1_700_000_000_000L, true)

        assertThrows(FileNotFoundException::class.java) {
            CloudDocumentThumbnails(derivatives, folder).open(document, entry, null)
        }

        assertFalse("the inserted entry was accounted, so the budget was enforced", evictable.exists())
        assertTrue("the cached AVIF is kept for the next view", folder.listFiles().orEmpty().any { it.name.endsWith(".avif") })
        assertEquals(emptyList<String>(), server.originalRequests)
    }
}
