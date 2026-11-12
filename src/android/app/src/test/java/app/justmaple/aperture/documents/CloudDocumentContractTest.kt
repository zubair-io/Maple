package app.justmaple.aperture.documents

import android.content.Context
import android.provider.DocumentsContract.Document
import org.robolectric.RuntimeEnvironment
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class CloudDocumentContractTest {
    private val server = "0f3c2c1e-4a5b-4c6d-8e9f-0a1b2c3d4e5f"
    private val library = "6af556d774fc0bdbaa866c39"

    @Test
    fun documentIdsRoundTripUnicodePathsAndRejectTraversal() {
        val photo = CloudDocumentId.file(server, library, "photos", "2026/Été #1/photo 😀.dng")
        val encoded = photo.encode()
        assertEquals(photo, CloudDocumentId.parse(encoded))
        assertEquals(5, encoded.split('/').size)
        assertEquals("photos:2026/Été #1/photo 😀.dng", photo.address)
        assertEquals(CloudDocumentId.folder(server, library, "photos", "2026/Été #1"), photo.parent())
        assertEquals(CloudDocumentId.folder(server, library, "photos", ""), photo.parent().parent().parent())
        assertEquals(CloudDocumentId.serverRoot(server), photo.parent().parent().parent().parent())
        assertEquals(CloudDocumentId.serverRoot(server), CloudDocumentId.parse(server))
        val encoder = java.util.Base64.getUrlEncoder().withoutPadding()
        for (path in listOf("../secret", "2026/../x", ".maple/thumbs/a.avif", "a//b", "a/./b", "a\\b")) {
            val forged = "$server/f/$library/photos/${encoder.encodeToString(path.toByteArray())}"
            assertThrows(path, IllegalArgumentException::class.java) { CloudDocumentId.parse(forged) }
        }
        for (forged in
            listOf(
                "",
                "$server/x/$library/photos/",
                "$server/f/$library/photos/",
                "$server/d/NOTHEX/photos/",
                "$server/d/$library/bad slug/",
                "$server/d/$library/photos/YQ==",
                "$server/d/$library/photos/a/b",
                "../$server",
            )) assertThrows(forged, IllegalArgumentException::class.java) { CloudDocumentId.parse(forged) }
    }

    @Test
    fun treeMembershipStaysInsideOneServerAndLibrary() {
        val root = CloudDocumentId.serverRoot(server)
        val libraryRoot = CloudDocumentId.folder(server, library, "photos", "")
        val year = CloudDocumentId.folder(server, library, "photos", "2026")
        val photo = CloudDocumentId.file(server, library, "photos", "2026/a.dng")
        assertTrue(root.contains(photo))
        assertTrue(libraryRoot.contains(year))
        assertTrue(year.contains(photo))
        assertFalse(year.contains(year))
        assertFalse(year.contains(CloudDocumentId.file(server, library, "photos", "20260/a.dng")))
        assertFalse(year.contains(CloudDocumentId.file(server, "6af556d774fc0bdbaa866c3a", "other", "2026/a.dng")))
        assertFalse(root.contains(CloudDocumentId.file("other-server", library, "photos", "2026/a.dng")))
        assertFalse(photo.contains(photo))
    }

    @Test
    fun renamesAndChildrenRejectNamesThatEscapeTheFolder() {
        val folder = CloudDocumentId.folder(server, library, "photos", "2026")
        assertEquals("2026/b.jpg", folder.child("b.jpg", false).path)
        assertEquals("2026/c.jpg", folder.child("b.jpg", false).renamed("c.jpg").path)
        for (name in listOf("", ".hidden", "a/b", "a\\b", "..", "x".repeat(256)))
            assertThrows(name, IllegalArgumentException::class.java) { folder.child(name, false) }
        assertThrows(IllegalStateException::class.java) {
            CloudDocumentId.folder(server, library, "photos", "").renamed("x")
        }
    }

    @Test
    fun rowsAdvertiseOnlyWhatTheServerAllows() {
        fun flags(kind: CloudEntryKind, indexed: Boolean) =
            CloudDocumentRows.flags(CloudEntry("a/b", kind, 1, 1, indexed))
        assertEquals(0, flags(CloudEntryKind.Sidecar, true))
        assertEquals(Document.FLAG_SUPPORTS_THUMBNAIL, flags(CloudEntryKind.Photo, false))
        val indexedPhoto = flags(CloudEntryKind.Photo, true)
        assertEquals(0, indexedPhoto and Document.FLAG_SUPPORTS_WRITE)
        assertNotEquals(0, indexedPhoto and Document.FLAG_SUPPORTS_DELETE)
        assertNotEquals(0, indexedPhoto and Document.FLAG_SUPPORTS_RENAME)
        assertNotEquals(0, flags(CloudEntryKind.File, false) and Document.FLAG_SUPPORTS_WRITE)
        val folder = flags(CloudEntryKind.Folder, false)
        assertEquals(0, folder and Document.FLAG_SUPPORTS_DELETE)
        assertNotEquals(0, folder and Document.FLAG_DIR_SUPPORTS_CREATE)
        assertEquals("image/x-adobe-dng", CloudDocumentRows.mime("A.DNG"))
        assertEquals("image/jpeg", CloudDocumentRows.mime("a.jpg"))
        assertEquals("application/rdf+xml", CloudDocumentRows.mime("a.xmp"))
        assertEquals("image/x-kodak-kdc", CloudDocumentRows.mime("a.KDC"))
        assertEquals("image/x-kodak-dcr", CloudDocumentRows.mime("a.dcr"))
        assertEquals("image/x-leaf-mos", CloudDocumentRows.mime("a.mos"))
        assertEquals("image/x-leica-rwl", CloudDocumentRows.mime("a.rwl"))
        assertEquals("application/octet-stream", CloudDocumentRows.mime("README"))
        assertEquals("scan.jpg", CloudDocumentRows.nameFor("scan", "image/jpeg"))
        assertEquals("scan.jpg", CloudDocumentRows.nameFor("scan.jpg", "image/jpeg"))
        assertEquals("Folder", CloudDocumentRows.nameFor("Folder", Document.MIME_TYPE_DIR))
        assertEquals("a (2).xmp", CloudDocumentRows.unique("a.xmp", false, setOf("a.xmp", "a (1).xmp")))
        assertEquals("v1.2 (1)", CloudDocumentRows.unique("v1.2", true, setOf("v1.2")))
        assertEquals("new.txt", CloudDocumentRows.unique("new.txt", false, setOf("old.txt")))
    }

    @Test
    fun changeFeedAdoptsTheHeadThenNotifiesAndRecoversFromExpiredCursors() {
        val preferences =
            RuntimeEnvironment.getApplication().getSharedPreferences("feed-test", Context.MODE_PRIVATE)
        preferences.edit().clear().commit()
        val requests = java.util.Collections.synchronizedList(mutableListOf<Long>())
        val history = (1L..1500L).map { CloudChange(it, library, "old/$it.jpg", null) }
        val pages =
            java.util.concurrent.LinkedBlockingQueue<(Long, Int) -> CloudChangePage>().apply {
                // Establish: two full history pages, no notifications.
                add { since, limit -> rows(history.filter { it.cursor > since }.take(limit)) }
                add { since, limit -> rows(history.filter { it.cursor > since }.take(limit)) }
                add { _, _ -> rows(listOf(CloudChange(1501, library, "2026/new.jpg", null))) }
                add { _, _ -> CloudChangePage.Expired(9000) }
                add { _, _ -> rows(emptyList()) }
            }
        val changed = CountDownLatch(1)
        val expired = CountDownLatch(1)
        val drained = CountDownLatch(1)
        val delivered = java.util.Collections.synchronizedList(mutableListOf<CloudChange>())
        val feed =
            CloudChangeFeed(
                { _, since, limit ->
                    requests += since
                    pages.poll()?.invoke(since, limit) ?: rows(emptyList()).also { drained.countDown() }
                },
                preferences,
                object : CloudChangeFeed.Listener {
                    override fun changed(server: String, changes: List<CloudChange>) {
                        delivered += changes
                        changed.countDown()
                    }

                    override fun expired(server: String) = expired.countDown()

                    override fun polled(server: String) = Unit
                },
                intervalMillis = 10,
            )
        feed.touch(server)
        assertTrue(changed.await(10, TimeUnit.SECONDS))
        assertTrue(expired.await(10, TimeUnit.SECONDS))
        assertTrue(drained.await(10, TimeUnit.SECONDS))
        assertEquals(listOf(1501L), delivered.map { it.cursor })
        // History is adopted page by page, never replayed; a 409 resumes from `current`, not 0.
        assertEquals(listOf(0L, 1000L, 1500L, 1501L, 9000L), requests.take(5))
        assertEquals(9000L, preferences.getLong("changes.cursor.$server", -1))
        feed.forget(server)
        assertEquals(-1L, preferences.getLong("changes.cursor.$server", -1))
    }

    private fun rows(changes: List<CloudChange>) = CloudChangePage.Rows(changes, changes.lastOrNull()?.cursor)
}
