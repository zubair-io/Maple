package app.justmaple.aperture.data

import android.content.Context
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.system.Os
import android.system.OsConstants
import app.justmaple.aperture.cloud.CloudLibrary
import java.io.File
import java.io.OutputStream
import java.util.UUID
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** Keeps the verified destination descriptor open through publication; never reopens with wt. */
internal class PhotoExport(private val context: Context, private val library: PhotoLibrary) {
    suspend fun write(photo: Photo, document: XmpDocument, destination: Uri, xmp: Boolean) =
        withContext(Dispatchers.IO) {
            check(destination != photo.uri) {
                "Choose an export destination other than the original"
            }
            if (destination.scheme == "file" && photo.uri.scheme == "file")
                check(
                    File(destination.path!!).canonicalPath != File(photo.uri.path!!).canonicalPath
                ) {
                    "Originals cannot be overwritten"
                }
            if (
                DocumentsContract.isDocumentUri(context, destination) &&
                    DocumentsContract.isDocumentUri(context, photo.uri)
            )
                check(
                    destination.authority != photo.uri.authority ||
                        DocumentsContract.getDocumentId(destination) !=
                            DocumentsContract.getDocumentId(photo.uri)
                ) {
                    "Originals cannot be overwritten"
                }
            if (xmp) {
                val bytes = XmpEncoding.encode(document.serialize())
                writeVerified(photo, destination) { it.write(bytes) }
            } else {
                val temp = File(context.cacheDir, "export-${UUID.randomUUID()}.jpg")
                try {
                    library.withOriginal(photo) { source ->
                        NativeBridge.export(
                            source.absolutePath,
                            document.serialize(),
                            temp.absolutePath,
                        )
                    }
                    writeVerified(photo, destination) { output ->
                        temp.inputStream().use { it.copyTo(output) }
                    }
                } finally {
                    temp.delete()
                }
            }
        }

    private fun writeVerified(photo: Photo, destination: Uri, write: (OutputStream) -> Unit) {
        val resolver = context.contentResolver
        // rw preserves the target while its identity is checked. Providers must support a
        // seekable regular descriptor; unsupported providers fail before any truncation.
        resolver.openFileDescriptor(destination, "rw")?.use { target ->
            val targetStat = Os.fstat(target.fileDescriptor)
            check(OsConstants.S_ISREG(targetStat.st_mode)) {
                "Choose a destination that supports safe file export"
            }
            if (!CloudLibrary.isCloud(photo.uri)) {
                resolver.openFileDescriptor(photo.uri, "r")?.use { original ->
                    val sourceStat = Os.fstat(original.fileDescriptor)
                    check(OsConstants.S_ISREG(sourceStat.st_mode)) {
                        "This provider cannot verify a safe export destination"
                    }
                    check(
                        sourceStat.st_dev != targetStat.st_dev ||
                            sourceStat.st_ino != targetStat.st_ino
                    ) {
                        "Originals cannot be overwritten"
                    }
                } ?: error("The original is unavailable; export was not written")
            }
            Os.ftruncate(target.fileDescriptor, 0)
            Os.lseek(target.fileDescriptor, 0, OsConstants.SEEK_SET)
            // The stream owns a duplicate of the checked descriptor, with the same inode
            // and offset. A provider cannot redirect a second open to the original.
            ParcelFileDescriptor.AutoCloseOutputStream(
                    ParcelFileDescriptor.dup(target.fileDescriptor)
                )
                .use(write)
        } ?: error("Export destination is unavailable")
    }
}
