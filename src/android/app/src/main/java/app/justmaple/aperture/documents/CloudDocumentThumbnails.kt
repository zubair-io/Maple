package app.justmaple.aperture.documents

import android.content.res.AssetFileDescriptor
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import app.justmaple.aperture.cloud.CloudDerivativePending
import app.justmaple.aperture.cloud.CloudLibrary
import app.justmaple.aperture.data.CloudDerivativeCache
import app.justmaple.aperture.data.CloudDerivativeUnconverted
import app.justmaple.aperture.data.OpenThumbnail
import app.justmaple.aperture.data.Photo
import app.justmaple.aperture.data.PhotoLibrary
import app.justmaple.aperture.data.trimCache
import java.io.File
import java.io.FileNotFoundException

/** Server 512 px thumbnails through the cloud derivative cache and its shared 64 MiB budget. */
internal class CloudDocumentThumbnails(
    private val derivatives: CloudDerivativeCache,
    private val folder: File,
) {
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
            } catch (unconverted: CloudDerivativeUnconverted) {
                if (unconverted.inserted)
                    trimCache(folder, PhotoLibrary.THUMBNAIL_BYTES, setOf(unconverted.payload, unconverted.index))
                throw FileNotFoundException("${file.name} has no thumbnail this Android version can show")
            } ?: throw FileNotFoundException("${file.name} has no thumbnail")
        cached.image.use { image ->
            if (cached.inserted)
                trimCache(folder, PhotoLibrary.THUMBNAIL_BYTES, setOfNotNull(image.file, cached.index))
            signal?.throwIfCanceled()
            return AssetFileDescriptor(
                ParcelFileDescriptor.dup(image.input.fd),
                0,
                AssetFileDescriptor.UNKNOWN_LENGTH,
            )
        }
    }

    companion object {
        /** The server's thumbnail tier; larger requests would fetch the 1280 px preview. */
        const val EDGE = 512
    }
}
