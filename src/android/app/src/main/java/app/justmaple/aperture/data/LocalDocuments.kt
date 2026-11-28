package app.justmaple.aperture.data

import android.content.Context
import android.net.Uri
import android.os.SystemClock
import android.provider.DocumentsContract
import java.lang.ref.SoftReference
import java.util.concurrent.atomic.AtomicLong

internal data class LocalDocument(
    val uri: Uri,
    val name: String,
    val directory: Boolean,
    val size: Long,
    val modified: Long,
    val flags: Int = 0,
)

/**
 * One folder snapshot supplies names and sibling URIs, without per-tile folder scans.
 * Listing/open/save refresh it; sidecar contents themselves are never cached.
 */
internal class LocalDocuments(
    private val context: Context,
    private val clock: () -> Long = SystemClock::elapsedRealtime,
) {
    internal class Recent(val taken: Long, val entries: SoftReference<List<LocalDocument>>)

    private class Slot {
        @Volatile var held: Recent? = null
        val generation = AtomicLong()

        fun discard() {
            generation.incrementAndGet()
            held = null
        }
    }

    @Volatile private var snapshot: Pair<Uri, List<LocalDocument>>? = null
    private val recentLock = Any()
    private val slots =
        object : LinkedHashMap<Uri, Slot>(RECENT_FOLDERS, 0.75f, true) {
            override fun removeEldestEntry(eldest: MutableMap.MutableEntry<Uri, Slot>) =
                (size > RECENT_FOLDERS).also { if (it) eldest.value.held = null }
        }

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

    /** One softly held listing for each of the last few folders: callers of a folder share a query, other folders never wait. */
    fun recent(folder: Uri): List<LocalDocument> {
        val slot = synchronized(recentLock) { slots.getOrPut(folder) { Slot() } }
        synchronized(slot) {
            slot.held
                ?.takeIf { clock() - it.taken < RECENT_MILLIS }
                ?.entries
                ?.get()
                ?.let {
                    return it
                }
            slot.held = null
            val seen = slot.generation.get()
            val taken = clock()
            val entries = query(folder)
            slot.held = Recent(taken, SoftReference(entries))
            // An invalidation of this folder can land between the query and the store above.
            if (slot.generation.get() != seen) slot.held = null
            return entries
        }
    }

    /** A publication guard's own listing; a held listing that disagrees with it is dropped, so the next lookup sees the change. */
    fun listVerified(folder: Uri): List<LocalDocument> =
        list(folder, fresh = true).also { entries ->
            peek(folder)?.takeIf { it.held?.entries?.get() != entries }?.discard()
        }

    internal fun held(folder: Uri): Recent? = peek(folder)?.held

    private fun peek(folder: Uri): Slot? =
        synchronized(recentLock) { slots.entries.firstOrNull { it.key == folder }?.value }

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
                DocumentsContract.Document.COLUMN_FLAGS,
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
                            cursor.getInt(5),
                        )
                    )
                }
            } ?: error("Folder permission is unavailable")
        return entries
    }

    fun invalidate(folder: Uri) {
        if (snapshot?.first == folder) snapshot = null
        peek(folder)?.discard()
    }

    fun invalidateAll() {
        snapshot = null
        synchronized(recentLock) { slots.values.toList() }.forEach { it.discard() }
    }

    private companion object {
        const val RECENT_MILLIS = 1_000L
        const val RECENT_FOLDERS = 4
    }
}
