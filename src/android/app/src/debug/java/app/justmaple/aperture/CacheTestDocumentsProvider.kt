package app.justmaple.aperture

import android.content.Intent
import android.database.Cursor
import android.database.MatrixCursor
import android.os.Bundle
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import android.provider.DocumentsProvider
import java.io.File
import java.io.FileNotFoundException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Debug-only, MANAGE_DOCUMENTS-protected fixture provider; absent from release APKs. */
class CacheTestDocumentsProvider : DocumentsProvider() {
    private val root
        get() = File(context!!.cacheDir, "cache-provider-fixtures").apply { mkdirs() }

    @Volatile private var readOnly = false
    @Volatile private var alias = false
    @Volatile private var failRename = false
    @Volatile private var zeroMtime = false
    @Volatile private var renamed = false
    @Volatile private var unsafeName = false
    @Volatile private var pausePublication = false
    @Volatile private var pauseSidecarRead: String? = null
    private val childQueries = java.util.concurrent.atomic.AtomicInteger()
    @Volatile private var blocked = false
    @Volatile private var release = CountDownLatch(1)

    override fun onCreate() = true

    override fun isChildDocument(parentDocumentId: String, documentId: String): Boolean =
        file(documentId).canonicalPath.startsWith(file(parentDocumentId).canonicalPath + "/")

    private fun file(id: String): File {
        val file = if (id == "root") root else File(root, id.removePrefix("root/"))
        require(
            file.canonicalPath == root.canonicalPath ||
                file.canonicalPath.startsWith(root.canonicalPath + "/")
        )
        return file
    }

    private fun id(file: File) = if (file == root) "root" else "root/" + file.relativeTo(root).path

    // Only test-granted tree URIs are used. Never advertise fixtures in the user's Files UI.
    override fun queryRoots(projection: Array<out String>?): Cursor =
        MatrixCursor(projection ?: arrayOf("root_id", "document_id", "title", "flags"))

    override fun queryDocument(documentId: String, projection: Array<out String>?): Cursor =
        cursor(projection, listOf(file(documentId)))

    override fun queryChildDocuments(
        parentDocumentId: String,
        projection: Array<out String>?,
        sortOrder: String?,
    ): Cursor {
        childQueries.incrementAndGet()
        return cursor(projection, file(parentDocumentId).listFiles().orEmpty().toList())
    }

    private fun cursor(projection: Array<out String>?, files: List<File>) =
        MatrixCursor(
                projection
                    ?: arrayOf(
                        Document.COLUMN_DOCUMENT_ID,
                        Document.COLUMN_DISPLAY_NAME,
                        Document.COLUMN_MIME_TYPE,
                        Document.COLUMN_SIZE,
                        Document.COLUMN_LAST_MODIFIED,
                        Document.COLUMN_FLAGS,
                    )
            )
            .apply {
                files
                    .filter { it.exists() }
                    .forEach { file ->
                        addRow(
                            columnNames.map { column ->
                                when (column) {
                                    Document.COLUMN_DOCUMENT_ID -> id(file)
                                    Document.COLUMN_DISPLAY_NAME ->
                                        if (file.name != "photo.dng") file.name
                                        else if (unsafeName) "../photo.dng"
                                        else if (renamed) "renamed.dng" else file.name
                                    Document.COLUMN_MIME_TYPE ->
                                        if (file.isDirectory) Document.MIME_TYPE_DIR
                                        else "application/octet-stream"
                                    Document.COLUMN_SIZE -> file.length()
                                    Document.COLUMN_LAST_MODIFIED ->
                                        if (zeroMtime) 0L else file.lastModified()
                                    Document.COLUMN_FLAGS ->
                                        if (readOnly) 0
                                        else if (file.isDirectory) Document.FLAG_DIR_SUPPORTS_CREATE
                                        else
                                            Document.FLAG_SUPPORTS_WRITE or
                                                (if (failRename) 0
                                                else Document.FLAG_SUPPORTS_RENAME) or
                                                Document.FLAG_SUPPORTS_DELETE
                                    else -> null
                                }
                            }
                        )
                    }
            }

    override fun openDocument(
        documentId: String,
        mode: String,
        signal: CancellationSignal?,
    ): ParcelFileDescriptor {
        if (readOnly && mode != "r") throw FileNotFoundException("Read-only fixture provider")
        if (
            (pausePublication && mode == "rw" && file(documentId).name.endsWith("tmp.avif")) ||
                (mode == "r" && file(documentId).name == pauseSidecarRead)
        ) {
            pausePublication = false
            pauseSidecarRead = null
            blocked = true
            try {
                check(release.await(15, TimeUnit.SECONDS)) { "Fixture publication wait timed out" }
            } finally {
                blocked = false
            }
        }
        return ParcelFileDescriptor.open(file(documentId), ParcelFileDescriptor.parseMode(mode))
    }

    override fun createDocument(
        parentDocumentId: String,
        mimeType: String,
        displayName: String,
    ): String {
        if (readOnly) throw FileNotFoundException("Read-only fixture provider")
        if (alias && displayName.startsWith(".maple-") && displayName.endsWith("tmp.avif"))
            return "root/photo.dng"
        require('/' !in displayName && '\\' !in displayName)
        val target = File(file(parentDocumentId), displayName)
        check(!target.exists())
        check(if (mimeType == Document.MIME_TYPE_DIR) target.mkdir() else target.createNewFile())
        return id(target)
    }

    override fun renameDocument(documentId: String, displayName: String): String {
        if (readOnly || (failRename && !displayName.startsWith(".")))
            throw UnsupportedOperationException("Rename unsupported")
        val original = file(documentId)
        val target = File(original.parentFile, displayName)
        check(!target.exists() && original.renameTo(target))
        return id(target)
    }

    override fun deleteDocument(documentId: String) {
        check(!readOnly && file(documentId).deleteRecursively())
    }

    override fun call(method: String, arg: String?, extras: Bundle?): Bundle? {
        if (method == "cache-test-state") return Bundle().apply { putBoolean("blocked", blocked); putInt("childQueries", childQueries.get()) }
        if (method == "cache-test-release") {
            release.countDown()
            return Bundle()
        }
        if (
            method != "cache-test-setup" &&
                method != "cache-test-mode" &&
                method != "cache-test-clear"
        )
            return super.call(method, arg, extras)
        if (method == "cache-test-clear") {
            root.deleteRecursively()
            return Bundle()
        }
        if (method == "cache-test-setup") {
            root.deleteRecursively()
            root.mkdirs()
            File(root, "photo.dng").writeBytes(requireNotNull(extras?.getByteArray("original")))
            context!!.grantUriPermission(
                "app.justmaple.aperture",
                DocumentsContract.buildTreeDocumentUri(
                    "app.justmaple.aperture.test.cache-documents",
                    "root",
                ),
                Intent.FLAG_GRANT_READ_URI_PERMISSION or
                    Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                    Intent.FLAG_GRANT_PREFIX_URI_PERMISSION,
            )
        }
        readOnly = extras?.getBoolean("readOnly") ?: false
        alias = extras?.getBoolean("alias") ?: false
        failRename = extras?.getBoolean("failRename") ?: false
        zeroMtime = extras?.getBoolean("zeroMtime") ?: false
        renamed = extras?.getBoolean("renamed") ?: false
        unsafeName = extras?.getBoolean("unsafeName") ?: false
        val nextPausePublication = extras?.getBoolean("pausePublication") ?: false
        val nextPauseSidecarRead = extras?.getString("pauseSidecarRead")
        if (nextPausePublication || nextPauseSidecarRead != null) release = CountDownLatch(1)
        pausePublication = nextPausePublication
        pauseSidecarRead = nextPauseSidecarRead
        return Bundle()
    }
}
