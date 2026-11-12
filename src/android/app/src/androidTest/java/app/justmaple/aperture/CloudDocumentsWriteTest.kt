package app.justmaple.aperture

import android.database.ContentObserver
import android.net.Uri
import android.os.Handler
import android.os.HandlerThread
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import androidx.test.platform.app.InstrumentationRegistry
import app.justmaple.aperture.MapleApiFixture.Companion.childrenUri
import app.justmaple.aperture.MapleApiFixture.Companion.documentUri
import app.justmaple.aperture.MapleApiFixture.Companion.rows
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

/** Create, write, rename, trash and change notifications against a real Maple API. */
class CloudDocumentsWriteTest {
    private lateinit var api: MapleApiFixture
    private lateinit var library: String
    private val resolver
        get() = api.context.contentResolver

    @Before
    fun signIn() {
        api = MapleApiFixture()
        library =
            rows(resolver.query(childrenUri(api.server.id), null, null, null, null))
                .single { it["name"] == "Android provider fixture" }["id"] as String
    }

    @After
    fun signOut() = api.close()

    private fun children(id: String) =
        rows(resolver.query(childrenUri(id), null, null, null, null)).associateBy { it["name"] as String }

    private fun read(id: String) =
        resolver.openInputStream(documentUri(id))!!.use { it.readBytes() }

    private fun write(id: String, bytes: ByteArray) =
        resolver.openOutputStream(documentUri(id), "wt")!!.use { it.write(bytes) }

    /** Uploads run after the writer closes; the listing reflects the server once they land. */
    private fun awaitServer(path: String, bytes: ByteArray) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(60)
        while (!api.serverBytes(path).contentEquals(bytes)) {
            assertTrue("$path did not reach the server", System.nanoTime() < deadline)
            Thread.sleep(250)
        }
    }

    @Test
    fun createsWritesRenamesAndTrashesThroughTheServer() {
        val name = "Provider ${UUID.randomUUID().toString().take(8)}"
        val folder = DocumentsContract.createDocument(resolver, documentUri(library), Document.MIME_TYPE_DIR, name)!!
        val folderId = DocumentsContract.getDocumentId(folder)
        assertTrue(name in children(library))
        val again = DocumentsContract.createDocument(resolver, documentUri(library), Document.MIME_TYPE_DIR, name)!!
        assertEquals("$name (1)", rows(resolver.query(again, null, null, null, null)).single()["name"])

        val note = DocumentsContract.createDocument(resolver, folder, "text/plain", "note")!!
        val noteId = DocumentsContract.getDocumentId(note)
        assertEquals("note.txt", children(folderId).getValue("note.txt")["name"])
        write(noteId, "hello maple".toByteArray())
        awaitServer("$name/note.txt", "hello maple".toByteArray())
        assertArrayEquals("hello maple".toByteArray(), read(noteId))
        assertEquals(11L, children(folderId).getValue("note.txt")["size"])

        // Rewriting an ordinary file replaces it on the server; the old copy goes to Maple Trash.
        write(noteId, "second".toByteArray())
        awaitServer("$name/note.txt", "second".toByteArray())

        val renamed = DocumentsContract.renameDocument(resolver, note, "renamed.txt")!!
        assertEquals(setOf("renamed.txt"), children(folderId).keys)
        assertArrayEquals("second".toByteArray(), api.serverBytes("$name/renamed.txt"))
        assertNull(api.serverBytes("$name/note.txt"))

        // A photo goes through its asset route: deletion is a reversible trash.
        val bytes = InstrumentationRegistry.getInstrumentation().context.assets.open("progressive-444.jpg").use { it.readBytes() }
        api.upload("$name/shot.jpg", bytes)
        val shot = children(folderId).getValue("shot.jpg")
        assertNotEquals(0, shot["flags"] as Int and Document.FLAG_SUPPORTS_DELETE)
        if (api.nativeEngine) {
            val moved = DocumentsContract.renameDocument(resolver, documentUri(shot["id"] as String), "kept.jpg")!!
            assertArrayEquals(bytes, read(DocumentsContract.getDocumentId(moved)))
            DocumentsContract.deleteDocument(resolver, moved)
            assertTrue("kept.jpg" in api.trashedNames())
        } else {
            // Without the server's native filename engine the asset rename fails closed.
            val failure =
                runCatching { DocumentsContract.renameDocument(resolver, documentUri(shot["id"] as String), "kept.jpg") }
            assertTrue(failure.isFailure || failure.getOrNull() == null)
            assertTrue("shot.jpg" in children(folderId))
            DocumentsContract.deleteDocument(resolver, documentUri(shot["id"] as String))
            assertTrue("shot.jpg" in api.trashedNames())
        }
        DocumentsContract.deleteDocument(resolver, renamed)
        assertNull(api.serverBytes("$name/renamed.txt"))
        assertTrue(children(folderId).isEmpty())

        val folderRenamed = DocumentsContract.renameDocument(resolver, folder, "$name moved")!!
        assertTrue("$name moved" in children(library))
        assertFalse(name in children(library))
        assertEquals(0, children(library).getValue("$name moved")["flags"] as Int and Document.FLAG_SUPPORTS_DELETE)
        assertFalse(runCatching { DocumentsContract.deleteDocument(resolver, folderRenamed) }.getOrDefault(false))
        assertTrue("$name moved" in children(library))
    }

    @Test
    fun anExistingSidecarIsNeverReplaced() {
        val name = "Sidecars ${UUID.randomUUID().toString().take(8)}"
        val folder = DocumentsContract.createDocument(resolver, documentUri(library), Document.MIME_TYPE_DIR, name)!!
        val folderId = DocumentsContract.getDocumentId(folder)
        val theirs = "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">theirs</x:xmpmeta>".toByteArray()
        val photo = InstrumentationRegistry.getInstrumentation().context.assets.open("progressive-444.jpg").use { it.readBytes() }
        api.upload("$name/edit.jpg", photo)
        api.upload("$name/edit.xmp", theirs)

        // A name already taken is never reused: the platform's own collision naming applies.
        val sibling = DocumentsContract.createDocument(resolver, folder, "application/rdf+xml", "edit.xmp")!!
        assertEquals("edit (1).xmp", rows(resolver.query(sibling, null, null, null, null)).single()["name"])
        assertTrue(DocumentsContract.deleteDocument(resolver, sibling))

        // Another device takes the name between create and upload: ours is kept beside it,
        // since the server answers 409 rather than replace an existing sidecar.
        val ours = "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">ours</x:xmpmeta>".toByteArray()
        api.upload("$name/late.jpg", photo)
        val pending = DocumentsContract.createDocument(resolver, folder, "application/rdf+xml", "late.xmp")!!
        api.upload("$name/late.xmp", theirs)
        write(DocumentsContract.getDocumentId(pending), ours)
        awaitServer("$name/late (1).xmp", ours)
        assertArrayEquals(theirs, api.serverBytes("$name/late.xmp"))
        assertArrayEquals(theirs, api.serverBytes("$name/edit.xmp"))
        assertEquals(0, children(folderId).getValue("edit.xmp")["flags"] as Int and Document.FLAG_SUPPORTS_WRITE)
        assertThrows(Exception::class.java) {
            resolver.openOutputStream(documentUri(children(folderId).getValue("edit.xmp")["id"] as String), "wt")
        }
    }

    @Test
    fun serverChangesNotifyOpenFoldersWithoutARelaunch() {
        val name = "Changes ${UUID.randomUUID().toString().take(8)}"
        val folder = DocumentsContract.createDocument(resolver, documentUri(library), Document.MIME_TYPE_DIR, name)!!
        val folderId = DocumentsContract.getDocumentId(folder)
        assertTrue(children(folderId).isEmpty())
        val thread = HandlerThread("provider-observer").apply { start() }
        val changed = CountDownLatch(1)
        val observer =
            object : ContentObserver(Handler(thread.looper)) {
                override fun onChange(selfChange: Boolean, uri: Uri?) = changed.countDown()
            }
        resolver.registerContentObserver(childrenUri(folderId), false, observer)
        try {
            // Let the feed adopt the journal head before the external change.
            Thread.sleep(6_000)
            api.upload("$name/from-web.txt", "made elsewhere".toByteArray())
            assertTrue("The change feed did not notify the folder", changed.await(60, TimeUnit.SECONDS))
            assertEquals(setOf("from-web.txt"), children(folderId).keys)
        } finally {
            resolver.unregisterContentObserver(observer)
            thread.quitSafely()
        }
    }
}
