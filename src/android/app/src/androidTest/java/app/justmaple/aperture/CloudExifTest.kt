package app.justmaple.aperture

import android.graphics.Bitmap
import android.media.ExifInterface
import android.net.Uri
import androidx.test.platform.app.InstrumentationRegistry
import app.justmaple.aperture.cloud.CloudCredentials
import app.justmaple.aperture.cloud.CloudServer
import app.justmaple.aperture.data.Photo
import app.justmaple.aperture.data.PhotoLibrary
import app.justmaple.aperture.data.readPhotoExif
import java.io.File
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class CloudExifTest {
    @Test fun infoReadsExifThroughTheAuthenticatedCloudOriginalWithoutChangingIt() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val directory = File(context.cacheDir, "exif-${java.util.UUID.randomUUID()}").apply { mkdirs() }
        val credentials = CloudCredentials(context)
        val id = java.util.UUID.randomUUID().toString()
        try {
            FileCloudServer(directory).use { server ->
                val bitmap = Bitmap.createBitmap(8, 6, Bitmap.Config.ARGB_8888)
                server.original.outputStream().use { assertTrue(bitmap.compress(Bitmap.CompressFormat.JPEG, 95, it)) }
                bitmap.recycle()
                ExifInterface(server.original.path).apply {
                    setAttribute(ExifInterface.TAG_MAKE, "Maple Cloud Fixture")
                    setAttribute(ExifInterface.TAG_MODEL, "Network Camera")
                    saveAttributes()
                }
                val original = server.original.readBytes()
                credentials.save(CloudServer(id, server.origin, "fixture-access-1", "fixture-refresh-1"))
                val uri = Uri.Builder().scheme("maple-cloud").authority(id)
                    .appendQueryParameter("address", "photos:2026/${server.original.name}")
                    .appendQueryParameter("path", server.original.path).build()
                val photo = Photo(uri, server.original.name, server.original.length(), 1, null)
                val metadata = readPhotoExif(PhotoLibrary(context), photo)
                assertEquals("Maple Cloud Fixture", metadata.cameraMake)
                assertEquals("Network Camera", metadata.cameraModel)
                assertArrayEquals(original, server.original.readBytes())
            }
        } finally {
            credentials.remove(id)
            directory.deleteRecursively()
        }
    }
}
