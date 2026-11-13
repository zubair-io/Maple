package app.justmaple.aperture.data

import android.content.Context
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.system.Os
import android.system.OsConstants
import android.system.StructStat
import java.io.InputStream
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** Derived files are disposable. Replacement uses a complete sibling, never an in-place write. */
internal class CacheDocuments(private val context: Context) {
    private val resolver = context.contentResolver
    private val documents = LocalDocuments(context)

    fun entries(directory: Uri) = documents.list(directory, fresh = true)

    fun directory(parent: Uri, tier: SharedCacheTier, create: Boolean): Uri? {
        val maple = childDirectory(parent, ".maple", create) ?: return null
        return childDirectory(maple, tier.directory, create)
    }

    private fun childDirectory(parent: Uri, name: String, create: Boolean): Uri? {
        val existing = entries(parent).filter { it.name == name }
        if (existing.isNotEmpty()) return existing.singleOrNull()?.takeIf { it.directory }?.uri
        if (!create) return null
        val uri =
            DocumentsContract.createDocument(
                resolver,
                parent,
                DocumentsContract.Document.MIME_TYPE_DIR,
                name,
            ) ?: return null
        return entries(parent)
            .singleOrNull { it.uri == uri && it.name == name && it.directory }
            ?.uri
    }

    fun find(entries: List<LocalDocument>, name: String) =
        entries.filter { it.name == name && !it.directory }.singleOrNull()

    /** A folder the server never sweeps may still hold the frozen `.v25` name; rename, never re-render. */
    suspend fun adoptLegacy(
        source: FolderCacheSource,
        tier: SharedCacheTier,
        directory: Uri,
        listed: List<LocalDocument>,
    ): List<LocalDocument> {
        val name = tier.filename(source.photo.name)
        if (find(listed, name) != null) return listed
        val legacy = find(listed, tier.legacyFilename(source.photo.name)) ?: return listed
        if (legacy.flags and DocumentsContract.Document.FLAG_SUPPORTS_RENAME == 0) return listed
        return try {
            publication.withLock {
                val current = entries(directory)
                if (find(current, name) != null || find(current, legacy.name) != legacy)
                    return@withLock current
                verifyDerived(source, legacy.uri)
                val renamed = rename(legacy.uri, name)
                val after = entries(directory)
                // Providers that de-duplicate on rename leave a stray sibling; it is derived data.
                if (find(after, name)?.uri == renamed) after
                else {
                    remove(source, renamed)
                    entries(directory)
                }
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            listed
        }
    }

    suspend fun publish(
        source: FolderCacheSource,
        tier: SharedCacheTier,
        input: InputStream,
        invalid: LocalDocument?,
        current: suspend () -> FolderCacheSource,
    ): Uri? = publication.withLock {
        currentCoroutineContext().ensureActive()
        if (!source.canShare || current() != source) return@withLock null
        val directory = directory(source.photo.parent!!, tier, true) ?: return@withLock null
        val name = tier.filename(source.photo.name)
        val initial = entries(directory)
        val before = find(initial, name)
        val companions =
            if (tier == SharedCacheTier.Preview)
                initial.filter {
                    !it.directory &&
                        it.name in
                            setOf(name.removeSuffix(".avif") + ".preview.json", "$name.source.json")
                }
            else emptyList()
        // A concurrent client may already have populated the slot. Never replace its newer render.
        if (before != null && before != invalid && before.modified >= source.modified)
            return@withLock null
        val id = UUID.randomUUID().toString()
        val tempName = ".maple-$id.tmp.avif"
        val temp =
            DocumentsContract.createDocument(resolver, directory, "image/avif", tempName)
                ?: return@withLock null
        var owned = false
        var identity: Pair<Long, Long>? = null
        var backup: Uri? = null
        var published: Uri? = null
        try {
            // Verify before any truncate, rename, or cleanup: an alias must never touch the source.
            val staged = find(entries(directory), tempName)
            check(staged?.uri == temp) { "Provider changed cache name" }
            check(staged.size == 0L) { "Provider returned an existing cache file" }
            identity =
                resolver.openFileDescriptor(temp, "r")?.use { descriptor ->
                    val stat = verifyDescriptor(source, descriptor)
                    check(stat.st_size == 0L) { "Provider returned existing source bytes" }
                    stat.st_dev to stat.st_ino
                } ?: error("Cannot verify new cache sibling")
            owned = true
            if (
                staged.flags and DocumentsContract.Document.FLAG_SUPPORTS_RENAME == 0 ||
                    (before != null &&
                        before.flags and DocumentsContract.Document.FLAG_SUPPORTS_RENAME == 0)
            )
                return@withLock null
            resolver.openFileDescriptor(temp, "rw")?.use { target ->
                val stat = verifyDescriptor(source, target)
                // MediaProvider may return FUSE for r and the lower filesystem for rw.
                // Check this actual writable descriptor before touching it; comparing
                // identities across those two mounts would reject legitimate providers.
                check(stat.st_size == 0L) { "Provider returned existing source bytes" }
                Os.ftruncate(target.fileDescriptor, 0)
                Os.lseek(target.fileDescriptor, 0, OsConstants.SEEK_SET)
                ParcelFileDescriptor.AutoCloseOutputStream(
                        ParcelFileDescriptor.dup(target.fileDescriptor)
                    )
                    .use { output ->
                        val bytes = ByteArray(64 * 1024)
                        while (true) {
                            currentCoroutineContext().ensureActive()
                            val count = input.read(bytes)
                            if (count < 0) break
                            output.write(bytes, 0, count)
                        }
                        output.flush()
                        Os.fsync(target.fileDescriptor)
                    }
            } ?: error("Cannot write shared cache")
            identity = verifyDerived(source, temp)
            currentCoroutineContext().ensureActive()
            if (current() != source || find(entries(directory), name) != before)
                return@withLock null
            if (before != null) {
                verifyDerived(source, before.uri)
                backup = rename(before.uri, ".maple-$id.backup.avif")
            }
            published = rename(temp, name)
            if (find(entries(directory), name)?.uri != published) {
                remove(source, published, identity)
                published = null
                error("Provider cannot replace shared cache")
            }
            val latest = current()
            if (latest != source) {
                remove(latest, published, identity)
                published = null
                return@withLock null
            }
            // A newly generated canonical AVIF replaces Hosted-private source bindings.
            // Retire only the unchanged records observed before this publication.
            for (companion in companions) {
                if (find(entries(directory), companion.name) == companion)
                    remove(source, companion.uri)
            }
            backup?.let { remove(source, it) }
            backup = null
            published
        } finally {
            if (owned && published == null) remove(source, temp, identity)
            // A crash can leave a hidden disposable backup, never a partial canonical image.
            backup?.let { previous ->
                if (find(entries(directory), name) == null) runCatching { rename(previous, name) }
            }
        }
    }

    private fun rename(uri: Uri, name: String) =
        DocumentsContract.renameDocument(resolver, uri, name)
            ?: error("Provider cannot rename cache")

    private fun remove(source: FolderCacheSource, uri: Uri, expected: Pair<Long, Long>? = null) {
        runCatching {
            val identity = verifyDerived(source, uri)
            check(expected == null || expected == identity)
            DocumentsContract.deleteDocument(resolver, uri)
        }
    }

    private fun verifyDerived(source: FolderCacheSource, uri: Uri): Pair<Long, Long> {
        check(uri != source.photo.uri && uri != source.sidecar?.uri)
        return resolver.openFileDescriptor(uri, "r")?.use {
            val stat = verifyDescriptor(source, it)
            stat.st_dev to stat.st_ino
        } ?: error("Cannot verify cache destination")
    }

    private fun verifyDescriptor(
        source: FolderCacheSource,
        target: ParcelFileDescriptor,
    ): StructStat {
        val stat = Os.fstat(target.fileDescriptor)
        check(OsConstants.S_ISREG(stat.st_mode) && stat.st_ino != 0L && stat.st_nlink == 1L) {
            "Provider cannot safely publish cache files"
        }
        for (uri in listOfNotNull(source.photo.uri, source.sidecar?.uri)) {
            resolver.openFileDescriptor(uri, "r")?.use { original ->
                val other = Os.fstat(original.fileDescriptor)
                check(OsConstants.S_ISREG(other.st_mode) && other.st_ino != 0L)
                check(stat.st_dev != other.st_dev || stat.st_ino != other.st_ino) {
                    "Cache destination aliases source data"
                }
            } ?: error("Source is unavailable")
        }
        return stat
    }

    companion object {
        private val publication = Mutex()
    }
}
