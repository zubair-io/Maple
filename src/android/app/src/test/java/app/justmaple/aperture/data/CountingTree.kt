package app.justmaple.aperture.data

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** A flat real folder behind a document provider that counts listings and opens and can hold one open. */
class CountingTree : ContentProvider() {
    class Gate(val name: String) {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
    }

    private fun file(uri: Uri) = File(directory, DocumentsContract.getDocumentId(uri).substringAfter('/'))

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
    ): Cursor {
        listings.incrementAndGet()
        return MatrixCursor(projection).apply {
            directory.listFiles().orEmpty().sortedBy { it.name }.forEach { entry ->
                addRow(
                    projection!!.map { column ->
                        when (column) {
                            Document.COLUMN_DOCUMENT_ID -> "root/${entry.name}"
                            Document.COLUMN_DISPLAY_NAME -> entry.name
                            Document.COLUMN_MIME_TYPE -> "application/octet-stream"
                            Document.COLUMN_SIZE -> entry.length()
                            Document.COLUMN_LAST_MODIFIED -> if (reportsModified) entry.lastModified() else 0
                            else -> 0
                        }
                    }
                )
            }
        }
    }

    override fun call(method: String, arg: String?, extras: Bundle?): Bundle? {
        val target = extras?.getParcelable<Uri>("uri") ?: return null
        return when (method) {
            "android:renameDocument" -> {
                val renamed = checkNotNull(extras.getString(Document.COLUMN_DISPLAY_NAME))
                check(file(target).renameTo(File(directory, renamed)))
                Bundle().apply { putParcelable("uri", documentUri(renamed)) }
            }
            "android:deleteDocument" -> {
                check(file(target).delete())
                Bundle()
            }
            "android:createDocument" -> {
                val created = checkNotNull(extras.getString(Document.COLUMN_DISPLAY_NAME))
                check(File(directory, created).createNewFile())
                Bundle().apply { putParcelable("uri", documentUri(created)) }
            }
            else -> null
        }
    }

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        val target = file(uri)
        if (target.name.endsWith(".xmp") && mode == "r") {
            opens.incrementAndGet()
            gate?.takeIf { it.name == target.name }?.let {
                gate = null
                it.entered.countDown()
                check(it.release.await(20, TimeUnit.SECONDS)) { "gate was never released" }
            }
        }
        return ParcelFileDescriptor.open(target, ParcelFileDescriptor.parseMode(mode))
    }

    override fun getType(uri: Uri): String? = null

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null

    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?) = 0

    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?) = 0

    companion object {
        const val AUTHORITY = "app.justmaple.aperture.test.counting-tree"
        lateinit var directory: File
        val listings = AtomicInteger()
        val opens = AtomicInteger()
        @Volatile var gate: Gate? = null
        @Volatile var reportsModified = true

        val folder: Uri =
            DocumentsContract.buildDocumentUriUsingTree(
                DocumentsContract.buildTreeDocumentUri(AUTHORITY, "root"),
                "root",
            )
    }
}
