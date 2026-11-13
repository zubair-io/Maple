package app.justmaple.aperture.documents

import android.os.CancellationSignal
import android.os.Handler
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract.Document
import android.util.Log
import app.justmaple.aperture.cloud.CloudStatusException
import java.io.FileNotFoundException
import java.io.IOException
import java.util.concurrent.Executor

/**
 * Create, rename, trash and upload through the server's path-keyed library routes.
 * Photos go through their asset routes so paired sidecars move with them; deletes are
 * always trash (#4706); an existing `.xmp` is never replaced.
 */
internal class CloudDocumentWrites(
    private val store: CloudDocumentStore,
    private val uploads: CloudPendingUploads,
    private val handler: Handler,
    private val worker: Executor,
) {
    private val api = store.api
    private val queued = mutableSetOf<String>()
    private val initializing = mutableMapOf<String, Pair<Any, Int>>()

    fun create(parent: CloudDocumentId, mime: String, displayName: String): CloudDocumentId {
        require(parent.directory && !parent.isServerRoot) { "Choose a Maple library folder" }
        val account = store.account(parent.server)
        val directory = mime == Document.MIME_TYPE_DIR
        val requested = CloudDocumentRows.nameFor(displayName.trim(), mime)
        CloudDocumentId.requireValidName(requested)
        val taken = store.names(parent)
        val created =
            if (directory)
                parent.child(CloudDocumentRows.unique(requested, true, taken), true).also {
                    api.mkdir(it)
                    store.remember(it, CloudEntry(it.path, CloudEntryKind.Folder, null, null, false))
                }
            else uploads.reserve(account, parent, requested, taken)
        store.notifyFolder(parent)
        return created
    }

    fun openForWrite(file: CloudDocumentId, mode: String, signal: CancellationSignal?): ParcelFileDescriptor {
        val account = store.account(file.server)
        // One opener stages a document at a time: another writer never sees a half-copied prefill.
        val upload =
            initializingOnce("$account|${file.library}|${file.path}") {
                uploads.find(account, file)?.let(uploads::opened) ?: staged(account, file, mode, signal)
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

    private fun staged(
        account: String,
        file: CloudDocumentId,
        mode: String,
        signal: CancellationSignal?,
    ): CloudPendingUploads.Upload {
        val entry = store.entry(file)
        if (entry.kind == CloudEntryKind.Sidecar)
            throw FileNotFoundException("${file.name} is a Maple sidecar; edits are saved by Maple, never replaced here")
        if (entry.kind != CloudEntryKind.File)
            throw FileNotFoundException("${file.name} is an original and stays read-only")
        // Registered as written before the prefill, so it is never uploaded half-copied.
        return uploads.create(account, file, writing = true).also { created ->
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

    private fun <T> initializingOnce(key: String, action: () -> T): T {
        val lock =
            synchronized(initializing) {
                val (shared, users) = initializing[key] ?: (Any() to 0)
                initializing[key] = shared to users + 1
                shared
            }
        try {
            return synchronized(lock, action)
        } finally {
            synchronized(initializing) {
                val (held, users) = initializing.getValue(key)
                if (users == 1) initializing.remove(key) else initializing[key] = held to users - 1
            }
        }
    }

    fun rename(id: CloudDocumentId, name: String): CloudDocumentId {
        val account = store.account(id.server)
        val target = id.renamed(name.trim())
        if (target == id) return id
        if (id.directory) {
            // Saved documents under the folder follow it; the drain would otherwise recreate the old folder.
            val prefix = "${id.path}/"
            uploads.holding(account, { it.library == id.library && it.path.startsWith(prefix) }) { held ->
                api.moveFolder(id, target)
                held.forEach { uploads.moved(it, "${target.path}/${it.path.removePrefix(prefix)}") }
            }
        } else
            // The destination's records are held too: one cannot start sending into the new name mid-rename.
            uploads.holding(account, { it.library == id.library && (it.path == id.path || it.path == target.path) }) {
                held ->
                val pending = held.singleOrNull { it.path == id.path }
                // The server cannot see a name that is only waiting to upload; its upload would replace this file.
                check(held.none { it.path == target.path }) { "An item named \"${target.name}\" already exists" }
                // A created document was never published: a server file at its name is another client's.
                if (pending != null && (pending.creates || !onServer(id))) {
                    check(target.name !in store.names(id.parent())) { "An item named \"${target.name}\" already exists" }
                } else
                    catalogued(id, { asset -> api.renameAsset(id, asset, target.name) }) {
                        api.renameFile(id, target.name)
                    }
                // A staged replacement goes to the new name, never back to the old one.
                pending?.let { uploads.moved(it, target.path) }
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
        val account = store.account(id.server)
        if (id.directory)
            throw UnsupportedOperationException("The Maple server cannot remove folders")
        uploads.holding(account, { it.library == id.library && it.path == id.path }) { held ->
            val pending = held.singleOrNull()
            // A created document was never published: a server file at its name is another client's.
            if (pending == null || (!pending.creates && onServer(id)))
                catalogued(id, { asset -> api.trashAsset(id, asset) }) { api.trashFile(id) }
            // A staged replacement of a trashed file must not bring it back.
            pending?.let(uploads::remove)
        }
        store.forget(id)
        store.notify(listOf(CloudDocumentStore.childrenUri(id.parent()), CloudDocumentStore.documentUri(id)))
    }

    /** Cached metadata proves the server has the file; its absence proves nothing, so ask. */
    private fun onServer(id: CloudDocumentId) = store.lookup(id) != null || api.stat(id) != null

    /**
     * Photos use their asset route, which carries paired sidecars. An unindexed photo has
     * no asset yet, and the plain-file route would separate it from its sidecar. The kind
     * is the server listing's, never a guess from the extension.
     */
    private fun catalogued(id: CloudDocumentId, asset: (String) -> Unit, file: () -> String?) {
        val kind = store.entry(id).kind
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
        for (due in uploads.due(store.account(server))) {
            val upload = uploads.claim(due) ?: continue
            val outcome =
                try {
                    send(server, upload)
                } finally {
                    uploads.release(upload)
                }
            if (outcome == Outcome.Paused) return
        }
    }

    /**
     * One record's attempt. Only a server-wide condition (unreachable, signed out, rate
     * limited, another account signed in) pauses the queue; a record the server rejects is
     * marked failed and the records after it still go out. A created document never lands
     * over a file another client put at its name meanwhile: that is a 409, and it moves aside.
     */
    private fun send(server: String, initial: CloudPendingUploads.Upload): Outcome {
        var upload = initial
        repeat(MAX_RENAMES) {
            val file = upload.document(server)
            val response =
                try {
                    api.upload(file, uploads.data(upload), upload.account, upload.creates)
                } catch (failure: IOException) {
                    Log.w("Maple", "Maple Cloud upload deferred", failure)
                    return Outcome.Paused
                }
            when {
                response.status in 200..299 -> {
                    uploads.sent(upload)
                    store.forget(file)
                    store.notify(listOf(CloudDocumentStore.childrenUri(file.parent()), CloudDocumentStore.documentUri(file)))
                    return Outcome.Done
                }
                // An existing sidecar, or any item at a created document's name, holds it: keep both.
                response.status == 409 -> {
                    val name = CloudDocumentRows.unique(file.name, false, store.names(file.parent()) + file.name)
                    Log.w("Maple", "Maple Cloud kept ${file.name} beside an existing item as $name")
                    upload = uploads.moved(upload, file.parent().child(name, false).path)
                    store.notifyFolder(file.parent())
                }
                response.status in PAUSING || response.status == 408 || response.status >= 500 -> {
                    Log.w("Maple", "Maple Cloud upload of ${file.name} deferred: HTTP ${response.status}")
                    return if (response.status in PAUSING) Outcome.Paused else Outcome.Deferred
                }
                else -> {
                    val failure =
                        runCatching { CloudDocumentsApi.ensure(response, "Upload ${file.name}") }
                            .exceptionOrNull() as? CloudStatusException
                    return rejected(file, upload, failure?.message ?: "HTTP ${response.status}")
                }
            }
        }
        return rejected(upload.document(server), upload, "No free name for ${upload.path.substringAfterLast('/')}")
    }

    private fun rejected(file: CloudDocumentId, upload: CloudPendingUploads.Upload, reason: String): Outcome {
        uploads.failed(upload, reason)
        Log.e("Maple", "Maple Cloud rejected ${file.name}: $reason")
        store.notifyFolder(file.parent())
        return Outcome.Done
    }

    private enum class Outcome {
        Done,
        Deferred,
        Paused,
    }

    companion object {
        private val TRUNCATING = setOf("w", "wt", "rwt")
        private val PAUSING = setOf(401, 429)
        private const val MAX_RENAMES = 20
    }
}
