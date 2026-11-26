package app.justmaple.aperture.data

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import java.io.File
import java.util.UUID
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

/** #6042: an interrupted save journaled under the hidden JPEG heals when its folded RAW loads. */
@RunWith(RobolectricTestRunner::class)
class FoldedSidecarRecoveryTest {
    class Tree : ContentProvider() {
        private fun name(uri: Uri) = DocumentsContract.getDocumentId(uri).substringAfter('/')

        private fun documentUri(name: String) =
            DocumentsContract.buildDocumentUriUsingTree(
                DocumentsContract.buildTreeDocumentUri(AUTHORITY, "root"),
                "root/$name",
            )

        override fun onCreate() = true

        override fun query(
            uri: Uri,
            projection: Array<out String>?,
            selection: String?,
            selectionArgs: Array<out String>?,
            sortOrder: String?,
        ): Cursor =
            MatrixCursor(projection).apply {
                files.forEach { (name, bytes) ->
                    addRow(
                        projection!!.map { column ->
                            when (column) {
                                Document.COLUMN_DOCUMENT_ID -> "root/$name"
                                Document.COLUMN_DISPLAY_NAME -> name
                                Document.COLUMN_MIME_TYPE -> "application/octet-stream"
                                Document.COLUMN_SIZE -> bytes.size.toLong()
                                Document.COLUMN_LAST_MODIFIED -> 1_700_000_000_000L
                                else -> 0
                            }
                        }
                    )
                }
            }

        override fun call(method: String, arg: String?, extras: Bundle?): Bundle? {
            val target = extras?.getParcelable<Uri>("uri") ?: return null
            return when (method) {
                "android:renameDocument" -> {
                    val renamed = checkNotNull(extras.getString(Document.COLUMN_DISPLAY_NAME))
                    files[renamed] = checkNotNull(files.remove(name(target)))
                    Bundle().apply { putParcelable("uri", documentUri(renamed)) }
                }
                "android:deleteDocument" -> {
                    files.remove(name(target))
                    Bundle()
                }
                "android:createDocument" -> {
                    val created = checkNotNull(extras.getString(Document.COLUMN_DISPLAY_NAME))
                    files[created] = ByteArray(0)
                    Bundle().apply { putParcelable("uri", documentUri(created)) }
                }
                else -> null
            }
        }

        override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
            val snapshot = File.createTempFile("document", ".bin")
            snapshot.deleteOnExit()
            snapshot.writeBytes(checkNotNull(files[name(uri)]))
            return ParcelFileDescriptor.open(snapshot, ParcelFileDescriptor.MODE_READ_ONLY)
        }

        override fun getType(uri: Uri): String? = null

        override fun insert(uri: Uri, values: ContentValues?): Uri? = null

        override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?) = 0

        override fun update(
            uri: Uri,
            values: ContentValues?,
            selection: String?,
            selectionArgs: Array<out String>?,
        ) = 0
    }

    private val context: Context = RuntimeEnvironment.getApplication()
    private val folder =
        DocumentsContract.buildDocumentUriUsingTree(
            DocumentsContract.buildTreeDocumentUri(AUTHORITY, "root"),
            "root",
        )
    private val edited = XmpDocument().withAttribute("xmp:Rating", "4").serialize()
    private val staged = XmpDocument().withAttribute("xmp:Rating", "5").serialize()
    private val id = UUID.randomUUID().toString()
    private val journals = File(context.filesDir, "sidecar-transactions")

    @Before
    fun interruptedBetweenTheTwoRenames() {
        Robolectric.setupContentProvider(Tree::class.java, AUTHORITY)
        files.clear()
        files["IMG_1.CR3"] = ByteArray(8)
        files["IMG_1.jpg"] = ByteArray(8)
        files[".maple-$id.backup.xmp"] = XmpEncoding.encode(edited)
        files[".maple-$id.xmp"] = XmpEncoding.encode(staged)
        journals.mkdirs()
    }

    private fun jpegJournal(library: PhotoLibrary): File {
        val jpeg = runBlocking { library.list(folder) }.photos.first().companion
        val record =
            File(journals, PhotoLibrary.digest(requireNotNull(jpeg).uri.toString()) + ".json")
        record.writeText(
            JSONObject()
                .put("id", id)
                .put("folder", folder.toString())
                .put("target", "IMG_1.xmp")
                .put("temp", ".maple-$id.xmp")
                .put("backup", ".maple-$id.backup.xmp")
                .put("previous", true)
                .put("digest", PhotoLibrary.digest(staged))
                .put("baseline", PhotoLibrary.digest(edited))
                .toString()
        )
        return record
    }

    @Test
    fun loadingTheFoldedRawHealsTheJpegsPendingReplacement() {
        val library = PhotoLibrary(context)
        val record = jpegJournal(library)
        val raw = runBlocking { library.list(folder) }.photos.single()

        assertEquals("IMG_1.CR3", raw.name)
        val loaded = runBlocking { library.loadSidecar(raw) }

        assertEquals(edited, loaded.baseline)
        assertFalse(record.exists())
        assertEquals(setOf("IMG_1.CR3", "IMG_1.jpg", "IMG_1.xmp"), files.keys)
    }

    @Test
    fun anUnfoldedRawLeavesTheJpegsJournalToTheJpegTile() {
        val library = PhotoLibrary(context)
        val record = jpegJournal(library)
        library.stackRawJpeg = false
        val (raw, jpeg) = runBlocking { library.list(folder) }.photos

        assertNull(runBlocking { library.loadSidecar(raw) }.baseline)
        assertTrue(record.exists())

        assertEquals(edited, runBlocking { library.loadSidecar(jpeg) }.baseline)
        assertFalse(record.exists())
    }

    private companion object {
        const val AUTHORITY = "app.justmaple.aperture.test.folded-recovery"
        val files = linkedMapOf<String, ByteArray>()
    }
}
