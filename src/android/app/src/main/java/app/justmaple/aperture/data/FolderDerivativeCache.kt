package app.justmaple.aperture.data

import android.content.Context
import android.os.Build
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.system.Os
import android.system.OsConstants
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive

internal data class CachedFolderDerivative(val image: OpenThumbnail, val inserted: Boolean)

private class SharedLease(val image: OpenThumbnail, val format: String, val identity: String)

/** The folder owns derivatives and is read in place; private files are capability fallbacks. */
internal class FolderDerivativeCache(private val context: Context) {
    private val documents = CacheDocuments(context)
    private val folder = File(context.cacheDir, "thumbnails")
    private val mirrorsRetired = AtomicBoolean(false)

    suspend fun load(
        edge: Int,
        snapshot: suspend () -> FolderCacheSource,
        render: suspend (FolderCacheSource, File, SharedCacheTier) -> Unit,
    ): CachedFolderDerivative {
        folder.mkdirs()
        retireMirrors()
        val tier = SharedCacheTier.forEdge(edge)
        repeat(2) {
            currentCoroutineContext().ensureActive()
            val source = snapshot()
            val entries = optional {
                documents.directory(source.photo.parent!!, tier, false)?.let { directory ->
                    val listed = documents.entries(directory)
                    if (source.canShare) documents.adoptLegacy(source, tier, directory, listed)
                    else listed
                }
            }
                .orEmpty()
            val entry =
                if (source.canShare) documents.find(entries, tier.filename(source.photo.name))
                else null
            val candidates =
                if (source.canShare)
                    sharedPreviewCandidates(context, documents, source, tier, entries)
                else emptyList()
            var shared: SharedLease? = null
            for (candidate in candidates) {
                val document = candidate.document
                shared = optional {
                    openShared(source, tier, document.uri, document.size, candidate.format)
                }
                if (shared != null) break
            }
            if (shared != null) {
                val unchanged =
                    try {
                        snapshot() == source
                    } catch (failure: Throwable) {
                        shared.image.close()
                        throw failure
                    }
                if (unchanged) return display(shared.image, false, shared.format, shared.identity)
                shared.image.close()
            }
            val key = "folder-${source.identity}-${tier.edge}"
            val ready = privateFile(key) { temporary -> render(source, temporary, tier) }
            val rendered = ready.image.file!!
            try {
                currentCoroutineContext().ensureActive()
                if (snapshot() == source) {
                    val published = optional {
                        ready.image.input.channel.position(0)
                        documents.publish(source, tier, ready.image.input, entry, snapshot)
                    }
                    val inPlace =
                        published?.let { uri ->
                            optional { openShared(source, tier, uri, rendered.length(), "avif") }
                        }
                    if (inPlace != null) {
                        // The folder now owns these bytes; the private render was only staging.
                        ready.image.close()
                        synchronized(OpenThumbnail.lock) { rendered.delete() }
                        val unchanged =
                            try {
                                snapshot() == source
                            } catch (failure: Throwable) {
                                inPlace.image.close()
                                throw failure
                            }
                        if (unchanged) return display(inPlace.image, false, "avif", inPlace.identity)
                        inPlace.image.close()
                        return@repeat
                    }
                    ready.image.input.channel.position(0)
                    if (snapshot() == source)
                        return display(ready.image, ready.inserted, "avif", rendered.nameWithoutExtension)
                }
            } catch (failure: Throwable) {
                ready.image.close()
                throw failure
            }
            ready.image.close()
        }
        error("The photo or sidecar changed while loading its preview. Reopen the folder.")
    }

    /** Reads the shared document through its own descriptor; any change while validating fails closed. */
    private suspend fun openShared(
        source: FolderCacheSource,
        tier: SharedCacheTier,
        uri: Uri,
        listedSize: Long,
        format: String,
    ): SharedLease {
        check(listedSize in 1..MAX_BYTES) { "Shared derivative size is out of range" }
        val descriptor =
            context.contentResolver.openFileDescriptor(uri, "r")
                ?: error("Shared derivative is unavailable")
        try {
            val opened = Os.fstat(descriptor.fileDescriptor)
            check(OsConstants.S_ISREG(opened.st_mode) && opened.st_size == listedSize) {
                "Shared derivative changed while reading"
            }
            currentCoroutineContext().ensureActive()
            check(NativeBridge.cacheValid(descriptor.fd, tier.edge, format)) {
                "Invalid shared derivative"
            }
            val validated = Os.fstat(descriptor.fileDescriptor)
            check(
                validated.st_dev == opened.st_dev &&
                    validated.st_ino == opened.st_ino &&
                    validated.st_size == opened.st_size &&
                    validated.st_mtim == opened.st_mtim
            ) {
                "Shared derivative changed while reading"
            }
            Os.lseek(descriptor.fileDescriptor, 0, OsConstants.SEEK_SET)
            val identity =
                PhotoLibrary.digest(
                    "${source.identity}:${tier.edge}:$uri:${opened.st_size}:${opened.st_mtim.tv_sec}:${opened.st_mtim.tv_nsec}"
                )
            return SharedLease(
                OpenThumbnail(null, ParcelFileDescriptor.AutoCloseInputStream(descriptor)),
                format,
                identity,
            )
        } catch (failure: Throwable) {
            descriptor.close()
            throw failure
        }
    }

    /** Builds before in-place reads copied every shared file here; drop those duplicates once. */
    private fun retireMirrors() {
        if (!mirrorsRetired.compareAndSet(false, true)) return
        synchronized(OpenThumbnail.lock) {
            folder.listFiles().orEmpty().filter { it.name.startsWith("shared-") }.forEach {
                it.delete()
            }
        }
    }

    private suspend fun privateFile(
        key: String,
        extension: String = "avif",
        create: suspend (File) -> Unit,
    ): CachedFolderDerivative {
        val file = File(folder, "$key.$extension")
        synchronized(OpenThumbnail.lock) {
            if (file.isFile && file.length() > 0) {
                file.setLastModified(System.currentTimeMillis())
                return CachedFolderDerivative(OpenThumbnail(file), false)
            }
        }
        val temporary = File.createTempFile("thumb-", ".avif", folder)
        try {
            create(temporary)
            currentCoroutineContext().ensureActive()
            return synchronized(OpenThumbnail.lock) {
                check(temporary.renameTo(file)) { "Cannot cache shared derivative" }
                CachedFolderDerivative(OpenThumbnail(file), true)
            }
        } finally {
            temporary.delete()
        }
    }

    private suspend fun display(
        image: OpenThumbnail,
        inserted: Boolean,
        format: String,
        identity: String,
    ): CachedFolderDerivative {
        if (Build.VERSION.SDK_INT >= 31 || format != "avif")
            return CachedFolderDerivative(image, inserted)
        // Android 10/11 use a private PNG decode bridge AFTER shared AVIF publication.
        try {
            val decoded =
                privateFile("legacy-png-$identity", "png") { output ->
                    ParcelFileDescriptor.dup(image.input.fd).use { pinned ->
                        NativeBridge.cachePng(pinned.fd, output.absolutePath)
                    }
                }
            return decoded.copy(inserted = decoded.inserted || inserted)
        } finally {
            image.close()
        }
    }

    private suspend fun <T> optional(action: suspend () -> T): T? =
        try {
            action()
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (_: Exception) {
            null
        }

    companion object {
        private const val MAX_BYTES = 32L * 1024 * 1024
    }
}
