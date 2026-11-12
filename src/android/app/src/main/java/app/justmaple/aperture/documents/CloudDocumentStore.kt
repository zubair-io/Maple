package app.justmaple.aperture.documents

import android.content.ContentResolver
import android.net.Uri
import android.provider.DocumentsContract
import android.util.Base64
import android.util.Log
import app.justmaple.aperture.cloud.CloudServer
import java.io.FileNotFoundException
import java.util.concurrent.Executor
import org.json.JSONObject

internal data class CloudChildren(val rows: List<CloudDocumentRow>, val loading: Boolean)

/**
 * Read side of the provider: connected servers, library roots, listings and the bounded
 * metadata that answers `queryDocument` without a request after a folder was listed.
 */
internal class CloudDocumentStore(
    private val connections: () -> List<CloudServer>,
    val api: CloudDocumentsApi,
    private val uploads: CloudPendingUploads,
    private val resolver: ContentResolver,
    private val loader: Executor,
) {
    private val libraries = mutableMapOf<String, List<CloudLibraryRoot>>()
    private val metadata =
        object : LinkedHashMap<String, CloudEntry>(256, 0.75f, true) {
            override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, CloudEntry>) =
                size > METADATA_ENTRIES
        }
    private val listings = mutableMapOf<String, Result<List<CloudEntry>>>()
    private val loadingListings = mutableSetOf<String>()

    fun servers() = connections()

    private fun connection(server: String): CloudServer =
        connections().find { it.id == server }
            ?: throw IllegalStateException(
                "This Maple Cloud server is no longer connected. Sign in again from Maple."
            )

    /**
     * A removed connection is an error for every document under it, never an empty folder.
     * Not a FileNotFoundException: DocumentsProvider.query turns that into a null cursor.
     */
    fun origin(server: String): String = connection(server).origin

    /** The signed-in user on this server: pending uploads belong to it, not to the origin. */
    fun account(server: String): String =
        connection(server).let { "${it.origin}#${subject(it.access)}" }

    fun libraries(server: String, refresh: Boolean = false): List<CloudLibraryRoot> {
        if (!refresh) synchronized(libraries) { libraries[server] }?.let { return it }
        val fresh = api.libraries(server)
        synchronized(libraries) { libraries[server] = fresh }
        return fresh
    }

    fun library(id: CloudDocumentId): CloudLibraryRoot =
        libraries(id.server).find { it.id == id.library }
            ?: libraries(id.server, refresh = true).find { it.id == id.library }
            ?: throw FileNotFoundException("This Maple library is no longer available")

    /**
     * The first page answers at once; later pages load in the background and the folder
     * is re-queried when they arrive (`EXTRA_LOADING` until then).
     */
    fun children(folder: CloudDocumentId): CloudChildren {
        origin(folder.server)
        if (folder.isServerRoot)
            return CloudChildren(
                libraries(folder.server, refresh = true).map { library ->
                    CloudDocumentRows.library(
                        CloudDocumentId.folder(folder.server, library.id, library.slug, ""),
                        library.label,
                    )
                },
                loading = false,
            )
        require(folder.directory) { "${folder.name} is not a folder" }
        val key = folder.encode()
        val loaded = synchronized(listings) { listings.remove(key) }?.getOrThrow()
        val first = if (loaded == null) api.page(folder, null) else null
        val entries = loaded ?: first!!.entries
        val loading = first?.next != null
        if (loading) loadRest(folder, first!!)
        val rows = entries.map { entry -> CloudDocumentRows.entry(remembered(folder, entry), entry) }
        if (loading) return CloudChildren(rows, loading = true)
        val listed = entries.mapTo(HashSet()) { it.path }
        val pending =
            uploads.children(account(folder.server), folder).filter { it.path !in listed }.map { upload ->
                val data = uploads.data(upload)
                CloudDocumentRows.pending(upload.document(folder.server), data.length(), data.lastModified(), upload.failure)
            }
        return CloudChildren(rows + pending, loading = false)
    }

    private fun loadRest(folder: CloudDocumentId, first: CloudListingPage) {
        val key = folder.encode()
        synchronized(listings) { if (!loadingListings.add(key)) return }
        loader.execute {
            val result = runCatching { (first.entries + api.rest(folder, first.next)).distinctBy { it.path } }
            result.exceptionOrNull()?.let { Log.w("Maple", "Maple Cloud folder listing failed", it) }
            synchronized(listings) {
                listings[key] = result
                loadingListings.remove(key)
            }
            notify(listOf(childrenUri(folder)))
        }
    }

    private fun remembered(folder: CloudDocumentId, entry: CloudEntry): CloudDocumentId {
        val id =
            if (entry.kind == CloudEntryKind.Folder)
                CloudDocumentId.folder(folder.server, folder.library!!, folder.slug!!, entry.path)
            else CloudDocumentId.file(folder.server, folder.library!!, folder.slug!!, entry.path)
        remember(id, entry)
        return id
    }

    fun names(folder: CloudDocumentId): Set<String> =
        api.list(folder).mapTo(HashSet()) { it.name } +
            uploads.children(account(folder.server), folder).map { it.path.substringAfterLast('/') }

    fun row(id: CloudDocumentId): CloudDocumentRow {
        origin(id.server)
        if (id.isServerRoot)
            return CloudDocumentRow(id.server, TITLE, DocumentsContract.Document.MIME_TYPE_DIR, null, null, 0)
        if (id.isLibraryRoot) return CloudDocumentRows.library(id, library(id).label)
        if (!id.directory && lookup(id) == null)
            uploads.find(account(id.server), id)?.let { upload ->
                val data = uploads.data(upload)
                return CloudDocumentRows.pending(id, data.length(), data.lastModified(), upload.failure)
            }
        return CloudDocumentRows.entry(id, entry(id))
    }

    /**
     * Metadata for a file or folder. A file's kind is only ever the server listing's
     * classification: `file-meta` cannot tell an original from a plain file, so an
     * uncached file is looked up in its folder's listing, never guessed from its name.
     */
    fun entry(id: CloudDocumentId): CloudEntry {
        lookup(id)?.let { return it }
        if (!id.directory) {
            // The listing answers directly: a large folder can evict this entry from the bounded cache.
            val parent = id.parent()
            val listed = api.list(parent).onEach { remembered(parent, it) }
            return listed.find { it.path == id.path && it.kind != CloudEntryKind.Folder }
                ?: throw FileNotFoundException("${id.name} no longer exists")
        }
        library(id)
        if (!api.folderExists(id)) throw FileNotFoundException("${id.name} no longer exists")
        return CloudEntry(id.path, CloudEntryKind.Folder, null, null, false).also { remember(id, it) }
    }

    /** The server's current size and mtime; a cached entry keeps the kind its listing gave it. */
    fun stat(file: CloudDocumentId): CloudFileStat {
        val stat = api.stat(file) ?: throw FileNotFoundException("${file.name} no longer exists")
        synchronized(metadata) {
            metadata[file.encode()]?.let {
                metadata[file.encode()] = it.copy(size = stat.size, modified = stat.modified)
            }
        }
        return stat
    }

    fun lookup(id: CloudDocumentId): CloudEntry? = synchronized(metadata) { metadata[id.encode()] }

    fun remember(id: CloudDocumentId, entry: CloudEntry) =
        synchronized(metadata) { metadata[id.encode()] = entry }

    fun forget(id: CloudDocumentId) =
        synchronized(metadata) {
            metadata.remove(id.encode())
            metadata.remove(id.copy(directory = !id.directory).encode())
        }

    fun forgetServer(server: String) {
        synchronized(metadata) { metadata.keys.removeAll { it == server || it.startsWith("$server/") } }
        synchronized(libraries) { libraries.remove(server) }
        synchronized(listings) { listings.keys.removeAll { it == server || it.startsWith("$server/") } }
    }

    /** Folder and item URIs touched by server changes; unknown libraries refresh the root. */
    fun changed(server: String, changes: List<CloudChange>): Set<Uri> {
        val uris = linkedSetOf<Uri>()
        val known = synchronized(libraries) { libraries[server] }
        val roots =
            if (known != null && changes.all { change -> known.any { it.id == change.library } }) known
            else libraries(server, refresh = true).also { uris += childrenUri(CloudDocumentId.serverRoot(server)) }
        for (change in changes) {
            val library = roots.find { it.id == change.library } ?: continue
            val relative =
                change.relativePath
                    ?: change.absolutePath?.removePrefix(library.path.trimEnd('/') + "/")
                        ?.takeIf { it != change.absolutePath }
            val root = CloudDocumentId.folder(server, library.id, library.slug, "")
            if (relative == null || relative.split('/').any { !CloudDocumentId.validName(it) }) {
                uris += childrenUri(root)
                continue
            }
            val file = CloudDocumentId.file(server, library.id, library.slug, relative)
            val folder = CloudDocumentId.folder(server, library.id, library.slug, relative)
            forget(file)
            uris += childrenUri(file.parent())
            uris += documentUri(file)
            uris += documentUri(folder)
        }
        return uris
    }

    fun notify(uris: Collection<Uri>) = uris.forEach { resolver.notifyChange(it, null, 0) }

    fun notifyFolder(id: CloudDocumentId) = notify(listOf(childrenUri(id), documentUri(id)))

    companion object {
        const val AUTHORITY = "app.justmaple.aperture.documents"
        const val TITLE = "Maple Cloud"
        private const val METADATA_ENTRIES = 4096

        /** The access token's `sub`: tokens rotate, the user they name does not. */
        fun subject(access: String): String =
            runCatching {
                    val payload = access.split('.')[1]
                    val json = String(Base64.decode(payload, Base64.URL_SAFE or Base64.NO_WRAP or Base64.NO_PADDING))
                    JSONObject(json).getString("sub").also { require(it.isNotBlank()) }
                }
                .getOrElse {
                    throw IllegalStateException("This Maple Cloud sign-in is invalid. Sign in again from Maple.")
                }

        fun childrenUri(id: CloudDocumentId): Uri =
            DocumentsContract.buildChildDocumentsUri(AUTHORITY, id.encode())

        fun documentUri(id: CloudDocumentId): Uri =
            DocumentsContract.buildDocumentUri(AUTHORITY, id.encode())
    }
}
