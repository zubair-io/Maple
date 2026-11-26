package app.justmaple.aperture.data

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import kotlinx.coroutines.runBlocking
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

/** #6042: a local document-tree folder lists one RAW tile per RAW+JPEG pair. */
@RunWith(RobolectricTestRunner::class)
class LocalRawJpegStackTest {
    class Tree : ContentProvider() {
        override fun onCreate() = true

        override fun query(
            uri: Uri,
            projection: Array<out String>?,
            selection: String?,
            selectionArgs: Array<out String>?,
            sortOrder: String?,
        ): Cursor =
            MatrixCursor(projection).apply {
                (files.map { it to false } + directories.map { it to true }).forEach {
                    (name, directory) ->
                    addRow(
                        projection!!.map { column ->
                            when (column) {
                                Document.COLUMN_DOCUMENT_ID -> "root/$name"
                                Document.COLUMN_DISPLAY_NAME -> name
                                Document.COLUMN_MIME_TYPE ->
                                    if (directory) Document.MIME_TYPE_DIR
                                    else "application/octet-stream"
                                Document.COLUMN_SIZE -> name.length.toLong()
                                Document.COLUMN_LAST_MODIFIED -> 1_700_000_000_000L
                                else -> 0
                            }
                        }
                    )
                }
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

    @Before
    fun serveTheFolder() {
        Robolectric.setupContentProvider(Tree::class.java, AUTHORITY)
    }

    private fun photos(library: PhotoLibrary) = runBlocking { library.list(folder) }.photos

    @Test
    fun aLocalFolderShowsOneRawTilePerPairByDefault() {
        val library = PhotoLibrary(context)

        assertTrue(library.stackRawJpeg)
        val photos = photos(library)
        assertEquals(
            listOf("IMG_1.CR3", "IMG_2.DNG", "IMG_2.jpeg", "IMG_2.jpg", "IMG_3.CR3", "solo.jpg"),
            photos.map { it.name },
        )
        val raw = photos.first()
        val jpeg = requireNotNull(raw.companion)
        assertEquals("img_1.JPG", jpeg.name)
        assertEquals(DocumentsContract.buildDocumentUriUsingTree(folder, "root/img_1.JPG"), jpeg.uri)
        assertEquals(folder, jpeg.parent)
        assertNull(jpeg.companion)
        assertEquals("IMG_1.xmp", raw.sidecarName)
        assertEquals(DocumentsContract.buildDocumentUriUsingTree(folder, "root/IMG_1.CR3"), raw.uri)
        assertTrue(photos.drop(1).all { it.companion == null })
    }

    @Test
    fun turningThePreferenceOffListsBothFilesAndIsRemembered() {
        val library = PhotoLibrary(context)
        library.stackRawJpeg = false

        val unfolded = photos(library)
        assertEquals(
            listOf(
                "IMG_1.CR3",
                "img_1.JPG",
                "IMG_2.DNG",
                "IMG_2.jpeg",
                "IMG_2.jpg",
                "IMG_3.CR3",
                "solo.jpg",
            ),
            unfolded.map { it.name },
        )
        assertTrue(unfolded.all { it.companion == null })
        assertFalse(PhotoLibrary(context).stackRawJpeg)

        PhotoLibrary(context).stackRawJpeg = true
        assertEquals(6, photos(library).size)
        assertEquals("img_1.JPG", photos(library).first().companion?.name)
    }

    @Test
    fun foldingKeepsEveryOtherPhotoInPlace() {
        fun photo(name: String, id: String = name) =
            Photo(Uri.parse("content://$AUTHORITY/document/$id"), name, 1, 2, folder)
        val solo = photo("a.jpg")
        val raw = photo("b.NEF")
        val jpeg = photo("B.jpeg")
        val twin = photo("c.CR3")
        val sameName = photo("c.CR3", "c-copy")
        val orphan = photo("c.jpg")

        assertEquals(
            listOf(solo, raw.copy(companion = jpeg), twin, sameName, orphan),
            RawJpegPairing.fold(listOf(solo, jpeg, raw, twin, sameName, orphan)),
        )
    }

    @Test
    fun onlyAnOpenLocalFolderRelistsWhenTheSwitchFlips() {
        val local = Folder(folder, "Trip")
        val cloud = Folder(Uri.parse("maple-cloud://server/library"), "Library")

        assertEquals(local, RawJpegPairing.folderToRelist(local))
        assertNull(RawJpegPairing.folderToRelist(cloud))
        assertNull(RawJpegPairing.folderToRelist(null))
    }

    private companion object {
        const val AUTHORITY = "app.justmaple.aperture.test.local-stack"
        val files =
            listOf(
                "IMG_2.jpg",
                "img_1.JPG",
                "IMG_1.xmp",
                "IMG_3.CR3",
                "IMG_2.DNG",
                "solo.jpg",
                "IMG_1.CR3",
                "IMG_2.jpeg",
            )
        val directories = listOf("IMG_3.jpg", "Trip")
    }
}
