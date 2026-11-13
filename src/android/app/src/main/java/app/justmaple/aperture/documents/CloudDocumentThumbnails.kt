package app.justmaple.aperture.documents

import android.content.res.AssetFileDescriptor
import android.os.Build
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import app.justmaple.aperture.cloud.CloudDerivativePending
import app.justmaple.aperture.cloud.CloudLibrary
import app.justmaple.aperture.data.CloudDerivativeCache
import app.justmaple.aperture.data.NativeBridge
import app.justmaple.aperture.data.OpenThumbnail
import app.justmaple.aperture.data.Photo
import app.justmaple.aperture.data.PhotoLibrary
import app.justmaple.aperture.data.trimCache
import java.io.File
import java.io.FileNotFoundException

/**
 * Server thumbnails (512 px AVIF, ETag-revalidated) through the app's cloud derivative
 * cache and its shared 64 MiB budget. Android 10/11 cannot decode AVIF, so the bounded
 * derivative is converted once to a private PNG by the shared core.
 */
internal class CloudDocumentThumbnails(cloud: CloudLibrary, private val folder: File) {
    private val derivatives = CloudDerivativeCache(cloud, folder)

    fun open(file: CloudDocumentId, entry: CloudEntry, signal: CancellationSignal?): AssetFileDescriptor {
        val photo =
            Photo(
                CloudLibrary.address(file.server, file.address, file.path),
                file.name,
                entry.size ?: 0L,
                entry.modified ?: 0L,
                null,
            )
        val cached =
            try {
                derivatives.load(photo, EDGE)
            } catch (pending: CloudDerivativePending) {
                throw FileNotFoundException("Maple is still preparing a thumbnail for ${file.name}")
            } ?: throw FileNotFoundException("${file.name} has no thumbnail")
        cached.image.use { image ->
            if (cached.inserted)
                trimCache(folder, PhotoLibrary.THUMBNAIL_BYTES, setOfNotNull(image.file, cached.index))
            signal?.throwIfCanceled()
            val descriptor =
                if (Build.VERSION.SDK_INT >= 31) ParcelFileDescriptor.dup(image.input.fd)
                else legacyPng(image)
            return AssetFileDescriptor(descriptor, 0, AssetFileDescriptor.UNKNOWN_LENGTH)
        }
    }

    private fun legacyPng(image: OpenThumbnail): ParcelFileDescriptor {
        val payload = checkNotNull(image.file) { "Thumbnail payload is not addressable" }
        val target = File(folder, "documents-${payload.nameWithoutExtension}.png")
        synchronized(OpenThumbnail.lock) {
            if (target.isFile) {
                target.setLastModified(System.currentTimeMillis())
                return ParcelFileDescriptor.open(target, ParcelFileDescriptor.MODE_READ_ONLY)
            }
        }
        val temporary = File.createTempFile("documents-", ".tmp", folder)
        try {
            ParcelFileDescriptor.dup(image.input.fd).use { pinned ->
                NativeBridge.cachePng(pinned.fd, temporary.absolutePath)
            }
            return synchronized(OpenThumbnail.lock) {
                check(temporary.renameTo(target)) { "Could not cache thumbnail" }
                val descriptor = ParcelFileDescriptor.open(target, ParcelFileDescriptor.MODE_READ_ONLY)
                trimCache(folder, PhotoLibrary.THUMBNAIL_BYTES, setOf(target))
                descriptor
            }
        } finally {
            temporary.delete()
        }
    }

    companion object {
        /** The server's thumbnail tier; larger requests would fetch the 1280 px preview. */
        const val EDGE = 512
    }
}
