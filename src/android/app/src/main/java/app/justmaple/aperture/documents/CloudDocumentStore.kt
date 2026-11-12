package app.justmaple.aperture.documents

import android.content.ContentResolver
import android.net.Uri
import android.provider.DocumentsContract
import app.justmaple.aperture.cloud.CloudCredentials
import java.io.FileNotFoundException

/**
 * Read side of the provider: connected servers, library roots, listings and the bounded
 * metadata that answers `queryDocument` without a request after a folder was listed.
 */
internal class CloudDocumentStore(
    private val credentials: CloudCredentials,
    val api: CloudDocumentsApi,
    private val uploads: CloudPendingUploads,
    private val resolver: ContentResolver,
) {
    private val libraries = mutableMapOf<String, List<CloudLibraryRoot>>()
    private val metadata =
        object : LinkedHashMap<String, CloudEntry>(256, 0.75f, true) {
            override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, CloudEntry>) =
                size > METADATA_ENTRIES
        }

    fun servers() = credentials.servers()

    /** A removed connection is an error for every document under it, never an empty folder. */
    fun origin(server: String): String =
        credentials.servers().find { it.id == server }?.origin
            ?: throw FileNotFoundException(
                "This Maple Cloud server is no longer connected. Sign in again from Maple."
            )

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

    fun children(folder: CloudDocumentId): List<CloudDocumentRow> {
        val origin = origin(folder.server)
        if (folder.isServerRoot)
            return libraries(folder.server, refresh = true).map { library ->
                CloudDocumentRows.library(
                    CloudDocumentId.folder(folder.server, library.id, library.slug, ""),
                    library.label,
                )
            }
        require(folder.directory) { "${folder.name} is not a folder" }
        val entries = api.list(folder)
        val rows =
            entries.map { entry ->
                val id =
                    if (entry.kind == CloudEntryKind.Folder)
                        CloudDocumentId.folder(folder.server, folder.library!!, folder.slug!!, entry.path)
                    else CloudDocumentId.file(folder.server, folder.library!!, folder.slug!!, entry.path)
                remember(id, entry)
                CloudDocumentRows.entry(id, entry)
            }
        val listed = entries.mapTo(HashSet()) { it.path }
        val pending =
            uploads.children(origin, folder).filter { it.path !in listed }.map { upload ->
                val data = uploads.data(upload)
                CloudDocumentRows.pending(upload.document(folder.server), data.length(), data.lastModified())
            }
        return rows + pending
    }

    fun names(folder: CloudDocumentId): Set<String> =
        api.list(folder).mapTo(HashSet()) { it.name } +
            uploads.children(origin(folder.server), folder).map { it.path.substringAfterLast('/') }

    fun row(id: CloudDocumentId): CloudDocumentRow {
        val origin = origin(id.server)
        if (id.isServerRoot)
            return CloudDocumentRow(id.server, TITLE, DocumentsContract.Document.MIME_TYPE_DIR, null, null, 0)
        if (id.isLibraryRoot) return CloudDocumentRows.library(id, library(id).label)
        uploads.find(origin, id)?.takeIf { !id.directory }?.let { upload ->
            val data = uploads.data(upload)
            if (lookup(id) == null) return CloudDocumentRows.pending(id, data.length(), data.lastModified())
        }
        return CloudDocumentRows.entry(id, entry(id))
    }

    /** Metadata for a file or folder, from the last listing or a stat of the server path. */
    fun entry(id: CloudDocumentId): CloudEntry {
        lookup(id)?.let { return it }
        val entry =
            if (id.directory) {
                library(id)
                if (!api.folderExists(id)) throw FileNotFoundException("${id.name} no longer exists")
                CloudEntry(id.path, CloudEntryKind.Folder, null, null, false)
            } else {
                val stat = api.stat(id) ?: throw FileNotFoundException("${id.name} no longer exists")
                val indexed =
                    stat.kind in setOf(CloudEntryKind.Photo, CloudEntryKind.Media) && api.assetAt(id) != null
                stat.copy(indexed = indexed)
            }
        remember(id, entry)
        return entry
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

        fun childrenUri(id: CloudDocumentId): Uri =
            DocumentsContract.buildChildDocumentsUri(AUTHORITY, id.encode())

        fun documentUri(id: CloudDocumentId): Uri =
            DocumentsContract.buildDocumentUri(AUTHORITY, id.encode())
    }
}
