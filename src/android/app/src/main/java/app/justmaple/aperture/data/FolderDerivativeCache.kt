package app.justmaple.aperture.data

import android.content.Context
import android.os.Build
import android.os.ParcelFileDescriptor
import app.justmaple.aperture.generated.AdjustmentFields
import java.io.File
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive

internal data class CachedFolderDerivative(val image: OpenThumbnail, val inserted: Boolean)

/** The folder owns derivatives; private copies are read-through leases and capability fallbacks. */
internal class FolderDerivativeCache(private val context: Context) {
    private val documents = CacheDocuments(context)
    private val folder = File(context.cacheDir, "thumbnails")

    suspend fun load(
        edge: Int,
        snapshot: suspend () -> FolderCacheSource,
        render: suspend (FolderCacheSource, File, SharedCacheTier) -> Unit,
    ): CachedFolderDerivative {
        folder.mkdirs()
        val tier = SharedCacheTier.forEdge(edge)
        repeat(2) {
            currentCoroutineContext().ensureActive()
            val source = snapshot()
            val entries = optional {
                documents.directory(source.photo.parent!!, tier, false)?.let { directory ->
                    documents.entries(directory)
                }
            }
                .orEmpty()
            val entry = documents.find(entries, tier.filename(source.photo.name))
            val candidates =
                if (source.canShare)
                    sharedPreviewCandidates(context, documents, source, tier, entries)
                else emptyList()
            var shared: CachedFolderDerivative? = null
            for (candidate in candidates) {
                shared = optional { mirror(source, tier, candidate) }
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
                if (unchanged) return display(shared)
                shared.image.close()
            }
            val key =
                "folder-${AdjustmentFields.pipelineOutputVersion}-${source.identity}-${tier.edge}"
            val ready = privateFile(key) { temporary -> render(source, temporary, tier) }
            try {
                currentCoroutineContext().ensureActive()
                if (snapshot() == source) {
                    optional {
                        ready.image.input.channel.position(0)
                        documents.publish(source, tier, ready.image.input, entry, snapshot)
                    }
                    ready.image.input.channel.position(0)
                    if (snapshot() == source) return display(ready)
                }
            } catch (failure: Throwable) {
                ready.image.close()
                throw failure
            }
            ready.image.close()
        }
        error("The photo or sidecar changed while loading its preview. Reopen the folder.")
    }

    private suspend fun mirror(
        source: FolderCacheSource,
        tier: SharedCacheTier,
        candidate: SharedCacheCandidate,
    ): CachedFolderDerivative? {
        val entry = candidate.document
        if (entry.size <= 0 || entry.size > MAX_BYTES) return null
        val key =
            "shared-${AdjustmentFields.pipelineOutputVersion}-${source.identity}-${tier.edge}-${PhotoLibrary.digest("${entry.uri}:${entry.size}:${entry.modified}")}"
        val extension = if (candidate.format == "jpeg") "jpg" else candidate.format
        return privateFile(key, extension) { temporary ->
            context.contentResolver.openInputStream(entry.uri)?.use { input ->
                temporary.outputStream().use { output ->
                    val buffer = ByteArray(64 * 1024)
                    var total = 0L
                    while (true) {
                        currentCoroutineContext().ensureActive()
                        val count = input.read(buffer)
                        if (count < 0) break
                        total += count
                        check(total <= MAX_BYTES && total <= entry.size) {
                            "Shared derivative changed while reading"
                        }
                        output.write(buffer, 0, count)
                    }
                    check(total == entry.size) { "Shared derivative is incomplete" }
                }
            } ?: error("Shared derivative is unavailable")
            check(NativeBridge.cacheValid(temporary.absolutePath, tier.edge, candidate.format)) {
                "Invalid shared derivative"
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

    private suspend fun display(canonical: CachedFolderDerivative): CachedFolderDerivative {
        if (Build.VERSION.SDK_INT >= 31) return canonical
        // Android 10/11 use a private JPEG decode bridge AFTER shared AVIF publication.
        try {
            val decoded =
                privateFile("legacy-${canonical.image.file.nameWithoutExtension}", "jpg") { output
                    ->
                    ParcelFileDescriptor.dup(canonical.image.input.fd).use { source ->
                        NativeBridge.thumbnail(
                            "/proc/self/fd/${source.fd}",
                            output.absolutePath,
                            "",
                            1280,
                        )
                    }
                }
            return decoded.copy(inserted = decoded.inserted || canonical.inserted)
        } finally {
            canonical.image.close()
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
