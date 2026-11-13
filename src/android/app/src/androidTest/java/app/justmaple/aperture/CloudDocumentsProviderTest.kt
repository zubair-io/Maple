package app.justmaple.aperture

import android.graphics.Point
import android.os.CancellationSignal
import android.os.OperationCanceledException
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import android.provider.DocumentsContract.Root
import androidx.test.platform.app.InstrumentationRegistry
import app.justmaple.aperture.MapleApiFixture.Companion.childrenUri
import app.justmaple.aperture.MapleApiFixture.Companion.documentUri
import app.justmaple.aperture.MapleApiFixture.Companion.rows
import app.justmaple.aperture.cloud.CloudLibrary
import app.justmaple.aperture.cloud.CloudServer
import app.justmaple.aperture.data.Folder
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

/** Browse, open and thumbnail Maple Cloud through the real provider and a real Maple API. */
class CloudDocumentsProviderTest {
    private lateinit var api: MapleApiFixture
    private val resolver
        get() = api.context.contentResolver

    @Before
    fun signIn() {
        api = MapleApiFixture()
    }

    @After
    fun signOut() = api.close()

    @Test
    fun browsesOpensAndThumbnailsRawAndJpegFromTheServer() {
        val roots =
            resolver.query(DocumentsContract.buildRootsUri(MapleApiFixture.AUTHORITY), null, null, null, null)!!.use {
                buildList {
                    while (it.moveToNext())
                        add(
                            it.getString(it.getColumnIndexOrThrow(Root.COLUMN_ROOT_ID)) to
                                it.getInt(it.getColumnIndexOrThrow(Root.COLUMN_FLAGS))
                        )
                }
            }
        val flags = roots.single { it.first == api.server.id }.second
        assertNotEquals(0, flags and Root.FLAG_SUPPORTS_IS_CHILD)
        val libraries = rows(resolver.query(childrenUri(api.server.id), null, null, null, null))
        val library = libraries.single { it["name"] == "Android provider fixture" }
        assertEquals(Document.MIME_TYPE_DIR, library["mime"])
        val top = rows(resolver.query(childrenUri(library["id"] as String), null, null, null, null))
        assertTrue(top.map { it["name"] }.containsAll(listOf("2026", "large", "notes.txt")))
        val year = top.single { it["name"] == "2026" }
        val tree = DocumentsContract.buildTreeDocumentUri(MapleApiFixture.AUTHORITY, year["id"] as String)
        val notes = top.single { it["name"] == "notes.txt" }["id"] as String
        assertThrows(SecurityException::class.java) {
            resolver.query(DocumentsContract.buildDocumentUriUsingTree(tree, notes), null, null, null, null)?.close()
        }
        val photos = rows(resolver.query(childrenUri(year["id"] as String), null, null, null, null)).associateBy { it["name"] }
        assertEquals(setOf("raw.dng", "photo.jpg", "raw.xmp"), photos.keys)
        assertEquals("image/x-adobe-dng", photos.getValue("raw.dng")["mime"])
        assertEquals("image/jpeg", photos.getValue("photo.jpg")["mime"])
        assertEquals(0, photos.getValue("raw.xmp")["flags"] as Int and (Document.FLAG_SUPPORTS_WRITE or Document.FLAG_SUPPORTS_DELETE))
        val assets = InstrumentationRegistry.getInstrumentation().context.assets
        val expected =
            mapOf(
                "raw.dng" to assets.open("source.dng").use { it.readBytes() },
                "photo.jpg" to assets.open("progressive-444.jpg").use { it.readBytes() },
            )
        for ((name, bytes) in expected) {
            val row = photos.getValue(name)
            assertEquals(bytes.size.toLong(), row["size"])
            assertNotEquals(0, row["flags"] as Int and Document.FLAG_SUPPORTS_THUMBNAIL)
            assertEquals(0, row["flags"] as Int and Document.FLAG_SUPPORTS_WRITE)
            val uri = documentUri(row["id"] as String)
            val opened = resolver.openFileDescriptor(uri, "r")!!.use { descriptor ->
                assertTrue("Downloads are seekable files", descriptor.statSize == bytes.size.toLong())
                java.io.FileInputStream(descriptor.fileDescriptor).readBytes()
            }
            assertArrayEquals(name, bytes, opened)
            val thumbnail = DocumentsContract.getDocumentThumbnail(resolver, uri, Point(256, 256), null)
            assertNotNull("$name thumbnail", thumbnail)
            assertTrue(thumbnail!!.width > 0 && thumbnail.height > 0)
            val single = rows(resolver.query(uri, null, null, null, null)).single()
            assertEquals(name, single["name"])
        }
        assertThrows(Exception::class.java) {
            resolver.openFileDescriptor(documentUri(photos.getValue("photo.jpg")["id"] as String), "w")
        }
        assertThrows(Exception::class.java) {
            resolver.openFileDescriptor(documentUri(photos.getValue("raw.xmp")["id"] as String), "w")
        }
    }

    @Test
    fun cancellingADownloadStopsTheTransferAndCachesNothing() {
        val library = rows(resolver.query(childrenUri(api.server.id), null, null, null, null))
            .single { it["name"] == "Android provider fixture" }
        val large =
            rows(resolver.query(childrenUri(library["id"] as String), null, null, null, null))
                .single { it["name"] == "large" }
        val file = rows(resolver.query(childrenUri(large["id"] as String), null, null, null, null)).single()
        assertEquals(512L shl 20, file["size"])
        val cache = File(api.context.cacheDir, "documents-provider/originals/${api.server.id}")
        val signal = CancellationSignal()
        val canceller = Executors.newSingleThreadExecutor()
        // ContentResolver.openFileDescriptor(uri, "r", signal) never hands the signal to a
        // DocumentsProvider: AOSP routes "r" through openTypedAssetFile("*/*"), which calls
        // openAssetFile(uri, "r") without it. A client's openFile(uri, mode, signal) does.
        val client = resolver.acquireUnstableContentProviderClient(MapleApiFixture.AUTHORITY)!!
        try {
            // Cancel only once bytes are demonstrably arriving, so a fast link cannot finish first.
            canceller.execute {
                val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(30)
                while (System.nanoTime() < deadline &&
                    cache.listFiles().orEmpty().none { it.name.endsWith(".tmp") && it.length() > 0 })
                    Thread.sleep(1)
                signal.cancel()
            }
            val started = System.nanoTime()
            assertThrows(OperationCanceledException::class.java) {
                client.openFile(documentUri(file["id"] as String), "r", signal)
            }
            assertTrue(System.nanoTime() - started < TimeUnit.SECONDS.toNanos(40))
            assertTrue("No partial download is kept", cache.listFiles().orEmpty().none { it.length() > 0 })
            val cancelled = CancellationSignal().apply { cancel() }
            assertThrows(OperationCanceledException::class.java) {
                client.openFile(documentUri(file["id"] as String), "r", cancelled)
            }
        } finally {
            canceller.shutdownNow()
            client.close()
        }
    }

    @Test
    fun tokenRotationRefreshesInPlaceAndSignOutIsAnErrorNotAnEmptyFolder() {
        val other = CloudServer("other-${api.server.id}", "http://127.0.0.1:9", "other-access", "other-refresh")
        api.credentials.save(other)
        val sources = api.context.getSharedPreferences("maple-library", 0)
        val retained = sources.getStringSet("sources", emptySet()).orEmpty()
        try {
            // An expired access token refreshes once; rotation keeps every other connection.
            api.credentials.save(api.server.copy(access = "expired-${api.server.access}"))
            val libraries = rows(resolver.query(childrenUri(api.server.id), null, null, null, null))
            assertTrue(libraries.any { it["name"] == "Android provider fixture" })
            val rotated = api.current()
            assertNotEquals(api.server.refresh, rotated.refresh)
            assertFalse(rotated.access.startsWith("expired-"))
            assertEquals(other, api.credentials.servers().single { it.id == other.id })
            assertEquals(retained, sources.getStringSet("sources", emptySet()).orEmpty())

            // An unreachable server reports a failure; it never lists as empty.
            assertThrows(Exception::class.java) {
                resolver.query(childrenUri(other.id), null, null, null, null)?.close()
            }

            runBlocking {
                CloudLibrary(api.context).disconnect(Folder(android.net.Uri.parse("maple-cloud://${api.server.id}"), "fixture"))
            }
            val roots =
                resolver.query(DocumentsContract.buildRootsUri(MapleApiFixture.AUTHORITY), null, null, null, null)!!
                    .use { cursor -> buildList { while (cursor.moveToNext()) add(cursor.getString(0)) } }
            assertFalse(api.server.id in roots)
            assertTrue(other.id in roots)
            assertThrows(Exception::class.java) {
                resolver.query(childrenUri(api.server.id), null, null, null, null)?.close()
            }
            assertEquals(other, api.credentials.servers().single { it.id == other.id })
        } finally {
            api.credentials.remove(other.id)
        }
    }
}
