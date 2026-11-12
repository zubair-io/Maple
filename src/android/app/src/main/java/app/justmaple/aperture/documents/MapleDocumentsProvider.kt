package app.justmaple.aperture.documents

import android.content.Context
import android.content.res.AssetFileDescriptor
import android.database.Cursor
import android.database.MatrixCursor
import android.graphics.Point
import android.net.Uri
import android.os.Binder
import android.os.Bundle
import android.os.CancellationSignal
import android.os.Handler
import android.os.HandlerThread
import android.os.OperationCanceledException
import android.os.ParcelFileDescriptor
import android.os.Process
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Root
import android.provider.DocumentsProvider
import android.util.Log
import app.justmaple.aperture.R
import app.justmaple.aperture.cloud.CloudLibrary
import app.justmaple.aperture.cloud.CloudStatusException
import java.io.File
import java.io.FileNotFoundException
import java.io.IOException
import java.util.concurrent.Executor
import java.util.concurrent.Executors

/**
 * Maple Cloud in the system Files app and every app's document picker: one root per
 * connected server, its libraries as folders, on-demand downloads and server thumbnails.
 * A failed or signed-out listing is always an error, never an empty folder.
 */
class MapleDocumentsProvider : DocumentsProvider() {
    private val host: Context
        get() = requireNotNull(context)

    private val cloud by lazy { CloudLibrary(host) }
    private val uploads by lazy { CloudPendingUploads(File(host.filesDir, "documents-provider/uploads")) }
    private val store by lazy {
        CloudDocumentStore(
            cloud.credentials::servers,
            CloudDocumentsApi(cloud.http),
            uploads,
            host.contentResolver,
            daemon("maple-documents-listings"),
        )
    }
    private val callbacks by lazy {
        Handler(HandlerThread("maple-documents-writers").apply { start() }.looper)
    }
    private val writes by lazy { CloudDocumentWrites(store, uploads, callbacks, daemon("maple-documents-uploads")) }
    private val originals by lazy {
        CloudOriginalCache(File(host.cacheDir, "documents-provider/originals"), store.api)
    }
    private val thumbnails by lazy { CloudDocumentThumbnails(cloud, File(host.cacheDir, "thumbnails")) }
    private val feed by lazy {
        CloudChangeFeed(
            store.api::changes,
            host.getSharedPreferences("maple-documents", Context.MODE_PRIVATE),
            object : CloudChangeFeed.Listener {
                override fun changed(server: String, changes: List<CloudChange>) =
                    store.notify(store.changed(server, changes))

                override fun expired(server: String) {
                    store.forgetServer(server)
                    store.notify(listOf(Uri.parse("content://${CloudDocumentStore.AUTHORITY}/")))
                }

                override fun polled(server: String) = writes.schedule(server)
            },
        )
    }

    override fun onCreate() = true

    override fun queryRoots(projection: Array<out String>?): Cursor {
        val cursor = MatrixCursor(projection ?: ROOT_PROJECTION)
        for (server in store.servers()) {
            cursor.addRow(
                cursor.columnNames.map { column ->
                    when (column) {
                        Root.COLUMN_ROOT_ID -> server.id
                        Root.COLUMN_DOCUMENT_ID -> server.id
                        Root.COLUMN_TITLE -> CloudDocumentStore.TITLE
                        Root.COLUMN_SUMMARY -> Uri.parse(server.origin).authority ?: server.origin
                        Root.COLUMN_FLAGS -> Root.FLAG_SUPPORTS_CREATE or Root.FLAG_SUPPORTS_IS_CHILD
                        Root.COLUMN_ICON -> R.drawable.maple_icon
                        else -> null
                    }
                }
            )
        }
        cursor.setNotificationUri(host.contentResolver, rootsUri)
        return cursor
    }

    override fun queryDocument(documentId: String, projection: Array<out String>?): Cursor = guarded {
        val id = active(documentId)
        CloudDocumentRows.cursor(projection, listOf(store.row(id))).apply {
            setNotificationUri(host.contentResolver, CloudDocumentStore.documentUri(id))
        }
    }

    override fun queryChildDocuments(
        parentDocumentId: String,
        projection: Array<out String>?,
        sortOrder: String?,
    ): Cursor = guarded {
        val parent = active(parentDocumentId)
        val children = store.children(parent)
        writes.schedule(parent.server)
        CloudDocumentRows.cursor(projection, children.rows).apply {
            setNotificationUri(host.contentResolver, CloudDocumentStore.childrenUri(parent))
            if (children.loading) extras = Bundle().apply { putBoolean(DocumentsContract.EXTRA_LOADING, true) }
        }
    }

    override fun isChildDocument(parentDocumentId: String, documentId: String): Boolean =
        runCatching { CloudDocumentId.parse(parentDocumentId).contains(CloudDocumentId.parse(documentId)) }
            .getOrDefault(false)

    override fun openDocument(
        documentId: String,
        mode: String,
        signal: CancellationSignal?,
    ): ParcelFileDescriptor = guarded {
        val file = active(documentId)
        if (file.directory) throw FileNotFoundException("${file.name} is a folder")
        if (mode != "r") return@guarded writes.openForWrite(file, mode, signal)
        if (store.lookup(file) == null)
            uploads.find(store.account(file.server), file)?.let { pending ->
                return@guarded ParcelFileDescriptor.open(uploads.data(pending), ParcelFileDescriptor.MODE_READ_ONLY)
            }
        // Stat first: the download is keyed by the server's current size and mtime.
        originals.open(file, store.stat(file), signal)
    }

    override fun openDocumentThumbnail(
        documentId: String,
        sizeHint: Point?,
        signal: CancellationSignal?,
    ): AssetFileDescriptor = guarded {
        val file = active(documentId)
        val entry = store.entry(file)
        if (entry.kind != CloudEntryKind.Photo) throw FileNotFoundException("${file.name} has no thumbnail")
        thumbnails.open(file, entry, signal)
    }

    override fun createDocument(parentDocumentId: String, mimeType: String, displayName: String): String =
        guarded { writes.create(active(parentDocumentId), mimeType, displayName).encode() }

    override fun renameDocument(documentId: String, displayName: String): String? = guarded {
        writes.rename(active(documentId), displayName).encode().takeIf { it != documentId }
    }

    override fun deleteDocument(documentId: String) = guarded { writes.delete(active(documentId)) }

    override fun removeDocument(documentId: String, parentDocumentId: String) = guarded {
        val id = active(documentId)
        require(id.parent().encode() == parentDocumentId) { "${id.name} is not in that folder" }
        writes.delete(id)
    }

    override fun call(method: String, arg: String?, extras: Bundle?): Bundle? {
        if (method != METHOD_CONNECTIONS) return super.call(method, arg, extras)
        if (Binder.getCallingUid() != Process.myUid()) throw SecurityException("Maple only")
        if (arg != null) {
            feed.forget(arg)
            store.forgetServer(arg)
            originals.forget(arg)
        }
        store.notify(listOf(rootsUri, Uri.parse("content://${CloudDocumentStore.AUTHORITY}/")))
        return Bundle()
    }

    /** Resolves a document of a connected server and keeps that server's change feed polling. */
    private fun active(documentId: String): CloudDocumentId {
        val id = CloudDocumentId.parse(documentId)
        store.origin(id.server)
        feed.touch(id.server)
        return id
    }

    /** Only exceptions that cross Binder intact leave the provider; 404 is a missing document. */
    private inline fun <T> guarded(action: () -> T): T =
        try {
            action()
        } catch (failure: CloudStatusException) {
            if (failure.status == 404) throw FileNotFoundException(failure.message)
            throw IllegalStateException(failure.message)
        } catch (failure: IOException) {
            if (failure is FileNotFoundException) throw failure
            Log.w("Maple", "Maple Cloud request failed", failure)
            throw IllegalStateException("Maple Cloud is unreachable: ${failure.message}")
        } catch (failure: OperationCanceledException) {
            throw failure
        }

    private val rootsUri
        get() = DocumentsContract.buildRootsUri(CloudDocumentStore.AUTHORITY)

    companion object {
        private const val METHOD_CONNECTIONS = "app.justmaple.aperture.documents.connections"
        private val ROOT_PROJECTION =
            arrayOf(
                Root.COLUMN_ROOT_ID,
                Root.COLUMN_DOCUMENT_ID,
                Root.COLUMN_TITLE,
                Root.COLUMN_SUMMARY,
                Root.COLUMN_FLAGS,
                Root.COLUMN_ICON,
            )

        private fun daemon(name: String): Executor =
            Executors.newSingleThreadExecutor { task -> Thread(task, name).apply { isDaemon = true } }

        /** Called by the app after sign-in or sign-out; a removed server's caches go with it. */
        internal fun connectionsChanged(context: Context, removed: String? = null) {
            try {
                context.contentResolver.call(CloudDocumentStore.AUTHORITY, METHOD_CONNECTIONS, removed, null)
            } catch (failure: RuntimeException) {
                Log.w("Maple", "Could not refresh Maple Cloud in the Files app", failure)
            }
        }
    }
}
