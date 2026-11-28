package app.justmaple.aperture.data

import app.justmaple.aperture.cloud.CloudBrowseWire
import app.justmaple.aperture.cloud.CloudSearchWire
import java.io.File
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The listing's thumbnail token rides each tile request and decides whether a cached tile needs one at all. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class CloudThumbnailTokenTest {
    @get:Rule val temporary = TemporaryFolder()
    private val server = CloudTileServer()

    @After fun stop() = server.close()

    private fun cache(folder: File) = CloudDerivativeCache(server.http, folder, { _, _ -> error("AVIF is shown as is") }, 36)

    private fun CloudDerivativeCache.bytes(photo: Photo, edge: Int = 512) =
        checkNotNull(load(photo, edge)).image.use { it.input.readBytes() }

    private fun indexNames(folder: File) = folder.listFiles().orEmpty().map { it.name }.filter { it.endsWith(".json") }.sorted()

    @Test
    fun theListingsTokenIsSentAsTheQueryOfTheTileRequest() {
        val derivatives = cache(temporary.newFolder())

        derivatives.bytes(server.photo("a.dng", token = "k3j9x"))
        derivatives.bytes(server.photo("b.dng"))

        assertEquals(
            listOf("/api/thumb/lib/2026/a.dng?v=k3j9x if-none-match=-", "/api/thumb/lib/2026/b.dng if-none-match=-"),
            server.thumbnailRequests,
        )
    }

    @Test
    fun aCachedTileWithTheListingsTokenIsServedWithNoRequestAtAll() {
        val folder = temporary.newFolder()
        val first = cache(folder).bytes(server.photo(token = "k3j9x"))

        val again = cache(folder).bytes(server.photo(token = "k3j9x"))
        val andAgain = cache(folder).bytes(server.photo(token = "k3j9x"))

        assertArrayEquals(first, again)
        assertArrayEquals(first, andAgain)
        assertEquals(1, server.requests.size)
        assertEquals(server.thumbnail.size.toLong(), server.thumbnailBytesServed)
    }

    @Test
    fun aChangedTokenRefetchesAndReplacesTheBytesUnderTheSameIndexName() {
        val folder = temporary.newFolder()
        cache(folder).bytes(server.photo(token = "old"))
        val before = indexNames(folder)
        val renewed = ByteArray(7_000) { (it % 199).toByte() }
        server.thumbnail = renewed

        val shown = cache(folder).bytes(server.photo(token = "new"))
        val after = cache(folder).bytes(server.photo(token = "new"))

        assertArrayEquals(renewed, shown)
        assertArrayEquals(renewed, after)
        assertEquals(before, indexNames(folder))
        assertEquals(2, server.thumbnailRequests.size)
        assertTrue(server.thumbnailRequests.last().startsWith("/api/thumb/lib/2026/a.dng?v=new if-none-match=\""))
        assertEquals("new", JSONObject(File(folder, before.single()).readText()).getString("token"))
    }

    @Test
    fun aChangedTokenWithUnchangedBytesIsAnsweredWithoutTheBodyAndRemembersTheNewToken() {
        val folder = temporary.newFolder()
        val first = cache(folder).bytes(server.photo(token = "old"))

        val revalidated = cache(folder).bytes(server.photo(token = "new"))
        cache(folder).bytes(server.photo(token = "new"))

        assertArrayEquals(first, revalidated)
        assertEquals(2, server.thumbnailRequests.size)
        assertEquals(server.thumbnail.size.toLong(), server.thumbnailBytesServed)
    }

    @Test
    fun theTokenIsRecordedInsideTheIndexAndNeverInAFileName() {
        val folder = temporary.newFolder()
        cache(folder).bytes(server.photo(token = "k3j9x"))

        assertTrue(folder.listFiles().orEmpty().none { "k3j9x" in it.name })
        assertEquals("k3j9x", JSONObject(File(folder, indexNames(folder).single()).readText()).getString("token"))
    }

    @Test
    fun aListingWithoutATokenKeepsRevalidatingEveryView() {
        val folder = temporary.newFolder()
        cache(folder).bytes(server.photo())
        cache(folder).bytes(server.photo())

        assertEquals(2, server.thumbnailRequests.size)
        assertFalse(server.thumbnailRequests.any { "?v=" in it })
        assertEquals(server.thumbnail.size.toLong(), server.thumbnailBytesServed)
    }

    @Test
    fun theLargerPreviewTierNeverCarriesOrReusesTheThumbnailToken() {
        val folder = temporary.newFolder()
        val derivatives = cache(folder)

        derivatives.bytes(server.photo(token = "k3j9x"), edge = 1024)
        derivatives.bytes(server.photo(token = "k3j9x"), edge = 1024)

        assertFalse(server.requests.any { "?v=" in it })
        assertEquals(2, server.thumbnailRequests.size)
    }

    @Test
    fun theListingAndSearchDecodersReadTheServersTokenField() {
        val folderRow = JSONObject("""{"address":"lib:a.dng","path":"/p/a.dng","name":"a.dng","size":5,"mtime":"2026-01-02T03:04:05Z","thumbVersion":"k3j9x"}""")
        val bare = JSONObject("""{"address":"lib:a.dng","path":"/p/a.dng","name":"a.dng","size":5,"mtime":"2026-01-02T03:04:05Z"}""")
        val searchRow = JSONObject("""{"address":"lib:a.dng","abs_path":"/p/a.dng","filename":"a.dng","size":5,"mtime":9,"thumb_version":"m1z"}""")

        assertEquals("k3j9x", CloudBrowseWire.photo(server.id, folderRow, null).thumbToken)
        assertNull(CloudBrowseWire.photo(server.id, bare, null).thumbToken)
        assertEquals("m1z", CloudSearchWire.photo(server.id, searchRow)!!.thumbToken)
    }
}
