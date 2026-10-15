package app.justmaple.aperture.data

import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract

internal data class LocalDocument(
    val uri: Uri,
    val name: String,
    val directory: Boolean,
    val size: Long,
    val modified: Long,
)

/**
 * One folder snapshot supplies names and sibling URIs, without per-tile folder scans.
 * Listing/open/save refresh it; sidecar contents themselves are never cached.
 */
internal class LocalDocuments(private val context: Context) {
    @Volatile private var snapshot: Pair<Uri, List<LocalDocument>>? = null

    fun list(folder: Uri, fresh: Boolean = false): List<LocalDocument> {
        if (!fresh)
            snapshot
                ?.takeIf { it.first == folder }
                ?.let {
                    return it.second
                }
        val entries = query(folder)
        snapshot = folder to entries
        return entries
    }

    // Sidebar expansion must not evict the active grid's sibling snapshot.
    fun folders(folder: Uri): List<Folder> =
        query(folder)
            .filter { it.directory && !it.name.startsWith(".") }
            .map { Folder(it.uri, it.name) }
            .sortedBy { it.name.lowercase() }

    private fun query(folder: Uri): List<LocalDocument> {
        val columns =
            arrayOf(
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_MIME_TYPE,
                DocumentsContract.Document.COLUMN_SIZE,
                DocumentsContract.Document.COLUMN_LAST_MODIFIED,
            )
        val query =
            DocumentsContract.buildChildDocumentsUriUsingTree(
                folder,
                DocumentsContract.getDocumentId(folder),
            )
        val entries: List<LocalDocument> =
            context.contentResolver.query(query, columns, null, null, null)?.use { cursor ->
                buildList<LocalDocument> {
                    while (cursor.moveToNext()) add(
                        LocalDocument(
                            DocumentsContract.buildDocumentUriUsingTree(
                                folder,
                                cursor.getString(0),
                            ),
                            cursor.getString(1).orEmpty(),
                            cursor.getString(2) == DocumentsContract.Document.MIME_TYPE_DIR,
                            cursor.getLong(3),
                            cursor.getLong(4),
                        )
                    )
                }
            } ?: error("Folder permission is unavailable")
        return entries
    }

    fun invalidate(folder: Uri) {
        if (snapshot?.first == folder) snapshot = null
    }
}
