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
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger

/** A flat real folder behind a document provider that counts listings and opens and can hold one open. */
class CountingTree : ContentProvider() {
    class Gate(val name: String) {
        val entered = CountDownLatch(1)
        val release = CountDownLatch(1)
    }

    private fun file(uri: Uri) = File(directory, DocumentsContract.getDocumentId(uri).substringAfter('/'))

    private fun documentUri(path: String) =
        DocumentsContract.buildDocumentUriUsingTree(
            DocumentsContract.buildTreeDocumentUri(AUTHORITY, "root"),
            path,
        )

    private fun folderOf(uri: Uri) =
        if (DocumentsContract.getDocumentId(uri) == ROOT) directory else file(uri)

    override fun onCreate() = true

    override fun query(
        uri: Uri,
        projection: Array<out String>?,
        selection: String?,
        selectionArgs: Array<out String>?,
        sortOrder: String?,
    ): Cursor {
        listings.incrementAndGet()
        val id = DocumentsContract.getDocumentId(uri)
        listed.computeIfAbsent(id) { AtomicInteger() }.incrementAndGet()
        listingGate?.takeIf { it.name == id }?.let {
            listingGate = null
            it.entered.countDown()
            check(it.release.await(20, TimeUnit.SECONDS)) { "gate was never released" }
        }
        check(!failListings && !failNextListing.getAndSet(false)) { "listing is refused" }
        val folder = file(uri).takeIf { id != ROOT && it.isDirectory } ?: directory
        val prefix = if (folder == directory) ROOT else id
        return MatrixCursor(projection).apply {
            folder.listFiles().orEmpty().sortedBy { it.name }.forEach { entry ->
                addRow(
                    projection!!.map { column ->
                        when (column) {
                            Document.COLUMN_DOCUMENT_ID -> "$prefix/${entry.name}"
                            Document.COLUMN_DISPLAY_NAME -> entry.name
                            Document.COLUMN_MIME_TYPE ->
                                if (entry.isDirectory) Document.MIME_TYPE_DIR else "application/octet-stream"
                            Document.COLUMN_SIZE -> entry.length()
                            Document.COLUMN_LAST_MODIFIED -> if (reportsModified) entry.lastModified() else 0
                            Document.COLUMN_FLAGS ->
                                if (supportsRename && entry.isFile) Document.FLAG_SUPPORTS_RENAME else 0
                            else -> 0
                        }
                    }
                )
            }
            if (folder == directory)
                phantomNames.forEach { phantom ->
                    addRow(
                        projection!!.map { column ->
                            when (column) {
                                Document.COLUMN_DOCUMENT_ID -> "$prefix/$phantom"
                                Document.COLUMN_DISPLAY_NAME -> phantom
                                Document.COLUMN_MIME_TYPE -> "application/octet-stream"
                                Document.COLUMN_SIZE -> 1L
                                Document.COLUMN_LAST_MODIFIED -> System.currentTimeMillis() - 30_000
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
                val folder = file(target).parentFile!!
                check(file(target).renameTo(File(folder, renamed)))
                val id = DocumentsContract.getDocumentId(target)
                Bundle().apply {
                    putParcelable("uri", documentUri("${id.substringBeforeLast('/')}/$renamed"))
                }
            }
            "android:deleteDocument" -> {
                check(!failDeletes) { "deleting is refused" }
                check(file(target).delete())
                Bundle()
            }
            "android:createDocument" -> {
                val created = checkNotNull(extras.getString(Document.COLUMN_DISPLAY_NAME))
                check(File(folderOf(target), created).createNewFile())
                val id = DocumentsContract.getDocumentId(target)
                Bundle().apply { putParcelable("uri", documentUri("$id/$created")) }
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
        return ParcelFileDescriptor.open(target, ParcelFileDescriptor.parseMode(mode)).also {
            DescriptorOs.remember(it.fileDescriptor, target)
        }
    }

    override fun getType(uri: Uri): String? = null

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null

    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?) = 0

    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?) = 0

    companion object {
        const val ROOT = "root"
        const val AUTHORITY = "app.justmaple.aperture.test.counting-tree"
        lateinit var directory: File
        val listings = AtomicInteger()
        val listed = ConcurrentHashMap<String, AtomicInteger>()
        @Volatile var listingGate: Gate? = null
        val opens = AtomicInteger()
        @Volatile var gate: Gate? = null
        @Volatile var reportsModified = true
        @Volatile var failDeletes = false
        @Volatile var supportsRename = false
        @Volatile var failListings = false
        val failNextListing = AtomicBoolean()
        @Volatile var phantomNames: List<String> = emptyList()

        fun resetFlags() {
            listingGate = null
            gate = null
            reportsModified = true
            failDeletes = false
            supportsRename = false
            failListings = false
            failNextListing.set(false)
            phantomNames = emptyList()
            DescriptorOs.forgetAll()
        }

        val folder: Uri =
            DocumentsContract.buildDocumentUriUsingTree(
                DocumentsContract.buildTreeDocumentUri(AUTHORITY, "root"),
                "root",
            )
    }
}
