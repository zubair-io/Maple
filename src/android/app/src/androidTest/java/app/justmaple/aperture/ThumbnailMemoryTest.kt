package app.justmaple.aperture

import android.graphics.BitmapFactory
import android.net.Uri
import androidx.test.platform.app.InstrumentationRegistry
import app.justmaple.aperture.cloud.CloudCredentials
import app.justmaple.aperture.cloud.CloudServer
import app.justmaple.aperture.data.Photo
import app.justmaple.aperture.data.PhotoLibrary
import app.justmaple.aperture.data.XmpDocument
import java.io.File
import java.util.UUID
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class ThumbnailMemoryTest {
    @Test
    fun nativeThumbnailFallbackHashesLargeSidecarsWithoutAWholeDocumentCopy() =
        runBlocking<Unit> {
            val i = InstrumentationRegistry.getInstrumentation()
            val context = i.targetContext
            val directory =
                File(context.cacheDir, "thumbnail-xmp-${UUID.randomUUID()}").apply { mkdirs() }
            val credentials = CloudCredentials(context)
            val id = UUID.randomUUID().toString()
            try {
                FileCloudServer(directory).use { server ->
                    i.context.assets.open("rgb-gradient.png").use { input ->
                        server.original.outputStream().use { input.copyTo(it) }
                    }
                    server.derivativesAvailable = false
                    server.sidecarLengthHeader = false
                    val parts = XmpDocument.EMPTY.split("<rdf:Description", limit = 2)
                    server.sidecar.bufferedWriter().use { output ->
                        output.write(parts[0])
                        output.write("<!--")
                        val chunk = "x".repeat(16 * 1024)
                        repeat(17 * 64) { output.write(chunk) }
                        output.write("--><rdf:Description")
                        output.write(parts[1])
                    }
                    credentials.save(
                        CloudServer(id, server.origin, "fixture-access-1", "fixture-refresh-1")
                    )
                    val uri =
                        Uri.Builder()
                            .scheme("maple-cloud")
                            .authority(id)
                            .appendQueryParameter("address", "photos:2026/${server.original.name}")
                            .appendQueryParameter("path", server.original.path)
                            .build()
                    val photo = Photo(uri, server.original.name, server.original.length(), 1, null)
                    val original = server.original.readBytes()
                    val thumbnail = PhotoLibrary(context).thumbnailPath(photo)
                    assertTrue(thumbnail.length() > 0)
                    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                    BitmapFactory.decodeFile(thumbnail.path, bounds)
                    assertTrue(bounds.outWidth in 1..512 && bounds.outHeight in 1..512)
                    assertTrue(server.sidecar.length() > 17L * 1024 * 1024)
                    assertArrayEquals(original, server.original.readBytes())
                }
            } finally {
                credentials.remove(id)
                directory.deleteRecursively()
            }
        }
}
