package app.justmaple.aperture.documents

import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import app.justmaple.aperture.data.PhotoLibrary
import java.io.File

/**
 * Downloaded server files for `openDocument`, streamed to disk (never buffered whole)
 * and keyed by path, size and mtime so a changed file is fetched again. Concurrent opens
 * of one version share a single download. Least recently opened files are evicted past
 * [limit]; an open descriptor keeps evicted bytes readable.
 */
internal class CloudOriginalCache(
    private val root: File,
    private val api: CloudDocumentsApi,
    private val limit: Long = 512L * 1024 * 1024,
) {
    private class Flight {
        var waiters = 0
    }

    private val flights = mutableMapOf<String, Flight>()

    fun open(file: CloudDocumentId, stat: CloudFileStat, signal: CancellationSignal?): ParcelFileDescriptor {
        val folder = folder(file.server)
        val key = PhotoLibrary.digestParts("documents-original-v1:", file.encode(), ":${stat.size}:${stat.modified}")
        val target = File(folder, if (file.extension.isEmpty()) key else "$key.${file.extension}")
        val flight = synchronized(flights) { flights.getOrPut(key, ::Flight).apply { waiters++ } }
        try {
            // A second opener waits here and then finds the first opener's download cached.
            synchronized(flight) {
                signal?.throwIfCanceled()
                cached(target)?.let { return it }
                return download(file, stat, folder, target, signal)
            }
        } finally {
            synchronized(flights) { if (--flight.waiters == 0) flights.remove(key) }
        }
    }

    private fun cached(target: File): ParcelFileDescriptor? =
        synchronized(lock) {
            if (!target.isFile) return null
            target.setLastModified(System.currentTimeMillis())
            ParcelFileDescriptor.open(target, ParcelFileDescriptor.MODE_READ_ONLY)
        }

    private fun download(
        file: CloudDocumentId,
        stat: CloudFileStat,
        folder: File,
        target: File,
        signal: CancellationSignal?,
    ): ParcelFileDescriptor {
        val temporary = File.createTempFile("download-", ".tmp", folder)
        try {
            temporary.outputStream().use { output -> api.download(file, output, signal) }
            signal?.throwIfCanceled()
            check(temporary.length() == stat.size) { "${file.name} changed while it was downloading. Try again." }
            return synchronized(lock) {
                check(temporary.renameTo(target)) { "Could not cache ${file.name}" }
                val descriptor = ParcelFileDescriptor.open(target, ParcelFileDescriptor.MODE_READ_ONLY)
                trim(target)
                descriptor
            }
        } finally {
            temporary.delete()
        }
    }

    /** Sign-out removes only that server's downloads. */
    fun forget(server: String) = synchronized(lock) { folder(server).deleteRecursively() }

    private fun folder(server: String) = File(root, server).apply { mkdirs() }

    /** One budget across every server; interrupted downloads older than a day are swept. */
    private fun trim(keep: File) {
        val stale = System.currentTimeMillis() - 86_400_000L
        var bytes = keep.length()
        root
            .listFiles()
            .orEmpty()
            .flatMap { it.listFiles().orEmpty().asList() }
            .filter { it.isFile && it != keep }
            .sortedByDescending { it.lastModified() }
            .forEach { file ->
                when {
                    file.name.endsWith(".tmp") -> if (file.lastModified() < stale) file.delete()
                    bytes + file.length() <= limit -> bytes += file.length()
                    else -> file.delete()
                }
            }
    }

    companion object {
        private val lock = Any()
    }
}
