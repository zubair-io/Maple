package app.justmaple.aperture.documents

import android.os.CancellationSignal
import android.os.Handler
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract.Document
import android.util.Log
import app.justmaple.aperture.cloud.CloudStatusException
import java.io.FileNotFoundException
import java.io.IOException
import java.util.concurrent.Executors

/**
 * Create, rename, trash and upload through the server's path-keyed library routes.
 * Photos go through their asset routes so paired sidecars move with them; deletes are
 * always trash (#4706); an existing `.xmp` is never replaced.
 */
internal class CloudDocumentWrites(
    private val store: CloudDocumentStore,
    private val uploads: CloudPendingUploads,
    private val handler: Handler,
) {
    private val api = store.api
    private val worker =
        Executors.newSingleThreadExecutor { task ->
            Thread(task, "maple-documents-uploads").apply { isDaemon = true }
        }
    private val queued = mutableSetOf<String>()

    fun create(parent: CloudDocumentId, mime: String, displayName: String): CloudDocumentId {
        require(parent.directory && !parent.isServerRoot) { "Choose a Maple library folder" }
        val origin = store.origin(parent.server)
        val directory = mime == Document.MIME_TYPE_DIR
        val requested = CloudDocumentRows.nameFor(displayName.trim(), mime)
        CloudDocumentId.requireValidName(requested)
        val name = CloudDocumentRows.unique(requested, directory, store.names(parent))
        val created = parent.child(name, directory)
        if (directory) {
            api.mkdir(created)
            store.remember(created, CloudEntry(created.path, CloudEntryKind.Folder, null, null, false))
        } else uploads.create(origin, created)
        store.notifyFolder(parent)
        return created
    }

    fun openForWrite(file: CloudDocumentId, mode: String, signal: CancellationSignal?): ParcelFileDescriptor {
        val origin = store.origin(file.server)
        val upload =
            uploads.find(origin, file)?.also(uploads::opened)
                ?: run {
                    val entry = store.entry(file)
                    if (entry.kind == CloudEntryKind.Sidecar)
                        throw FileNotFoundException(
                            "${file.name} is a Maple sidecar; edits are saved by Maple, never replaced here"
                        )
                    if (entry.kind != CloudEntryKind.File)
                        throw FileNotFoundException("${file.name} is an original and stays read-only")
                    // Registered as written before the prefill, so it is never uploaded half-copied.
                    uploads.create(origin, file, writing = true).also { created ->
                        if (mode !in TRUNCATING)
                            try {
                                uploads.data(created).outputStream().use { api.download(file, it, signal) }
                            } catch (failure: Exception) {
                                uploads.closed(created, clean = false)
                                uploads.remove(created)
                                throw failure
                            }
                    }
                }
        return try {
            ParcelFileDescriptor.open(uploads.data(upload), ParcelFileDescriptor.parseMode(mode), handler) {
                failure ->
                uploads.closed(upload, failure == null)
                if (failure != null) Log.w("Maple", "Maple Cloud writer closed with an error", failure)
                schedule(file.server)
            }
        } catch (failure: IOException) {
            uploads.closed(upload, clean = false)
            throw failure
        }
    }

    fun rename(id: CloudDocumentId, name: String): CloudDocumentId {
        val origin = store.origin(id.server)
        val target = id.renamed(name.trim())
        if (target == id) return id
        if (id.directory) api.moveFolder(id, target)
        else {
            val pending = uploads.find(origin, id)
            if (pending != null && store.lookup(id) == null) {
                check(target.name !in store.names(id.parent())) { "An item named \"${target.name}\" already exists" }
                uploads.moved(pending, target.path)
            } else catalogued(id, { asset -> api.renameAsset(id, asset, target.name) }) {
                api.renameFile(id, target.name)
            }
        }
        store.forget(id)
        store.notify(
            listOf(
                CloudDocumentStore.childrenUri(id.parent()),
                CloudDocumentStore.documentUri(id),
                CloudDocumentStore.documentUri(target),
            )
        )
        return target
    }

    fun delete(id: CloudDocumentId) {
        val origin = store.origin(id.server)
        if (id.directory)
            throw UnsupportedOperationException("The Maple server cannot remove folders")
        val pending = uploads.find(origin, id)
        if (pending != null && store.lookup(id) == null) uploads.remove(pending)
        else catalogued(id, { asset -> api.trashAsset(id, asset) }) { api.trashFile(id) }
        store.forget(id)
        store.notify(listOf(CloudDocumentStore.childrenUri(id.parent()), CloudDocumentStore.documentUri(id)))
    }

    /**
     * Photos use their asset route, which carries paired sidecars. An unindexed photo has
     * no asset yet, and the plain-file route would separate it from its sidecar.
     */
    private fun catalogued(id: CloudDocumentId, asset: (String) -> Unit, file: () -> String?) {
        val kind = CloudDocumentsApi.kindOf(id.name)
        if (kind == CloudEntryKind.Sidecar)
            throw UnsupportedOperationException("Maple sidecars move and trash with their photo")
        val known = api.assetAt(id)
        if (known != null) return asset(known)
        if (kind == CloudEntryKind.Photo || kind == CloudEntryKind.Media)
            throw IllegalStateException("Maple is still indexing ${id.name}. Try again shortly.")
        file()?.let(asset)
    }

    /** Uploads due documents for one server, one at a time, off the binder threads. */
    fun schedule(server: String) {
        synchronized(queued) { if (!queued.add(server)) return }
        worker.execute {
            synchronized(queued) { queued.remove(server) }
            runCatching { drain(server) }
                .onFailure { Log.w("Maple", "Maple Cloud uploads paused", it) }
        }
    }

    private fun drain(server: String) {
        val origin = store.origin(server)
        for (upload in uploads.due(origin)) if (!send(server, upload)) return
    }

    /** False when the server is unreachable or rejects the session: retry on the next poll. */
    private fun send(server: String, initial: CloudPendingUploads.Upload): Boolean {
        var upload = initial
        repeat(MAX_RENAMES) {
            val file = upload.document(server)
            val response =
                try {
                    api.upload(file, uploads.data(upload))
                } catch (failure: IOException) {
                    Log.w("Maple", "Maple Cloud upload deferred", failure)
                    return false
                }
            when {
                response.status in 200..299 -> {
                    uploads.remove(upload)
                    store.forget(file)
                    store.notify(listOf(CloudDocumentStore.childrenUri(file.parent()), CloudDocumentStore.documentUri(file)))
                    return true
                }
                // An existing sidecar (or a racing upload) holds the name: keep both.
                response.status == 409 -> {
                    val name = CloudDocumentRows.unique(file.name, false, store.names(file.parent()) + file.name)
                    upload = uploads.moved(upload, file.parent().child(name, false).path)
                    store.notifyFolder(file.parent())
                }
                response.status in RETRYABLE || response.status >= 500 -> return false
                else -> {
                    val failure =
                        runCatching { CloudDocumentsApi.ensure(response, "Upload ${file.name}") }
                            .exceptionOrNull() as? CloudStatusException
                    uploads.failed(upload, failure?.message ?: "HTTP ${response.status}")
                    Log.e("Maple", "Maple Cloud rejected ${file.name}: ${failure?.message}")
                    return true
                }
            }
        }
        return true
    }

    companion object {
        private val TRUNCATING = setOf("w", "wt", "rwt")
        private val RETRYABLE = setOf(401, 403, 408, 429)
        private const val MAX_RENAMES = 20
    }
}
