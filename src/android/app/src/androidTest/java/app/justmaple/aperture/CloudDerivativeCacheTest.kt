package app.justmaple.aperture

import android.graphics.Bitmap
import android.net.Uri
import androidx.test.platform.app.InstrumentationRegistry
import app.justmaple.aperture.cloud.CloudCredentials
import app.justmaple.aperture.cloud.CloudServer
import app.justmaple.aperture.data.Photo
import app.justmaple.aperture.data.PhotoLibrary
import java.io.File
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class CloudDerivativeCacheTest {
    @androidx.test.filters.SdkSuppress(minSdkVersion = 31)
    @Test
    fun cachedDerivativesRevalidateWithoutRetransferringAndRefreshChangedBytes() =
        runBlocking<Unit> {
            val instrumentation = InstrumentationRegistry.getInstrumentation()
            val context = instrumentation.targetContext
            val directory =
                File(context.cacheDir, "cloud-cache-${java.util.UUID.randomUUID()}").apply {
                    mkdirs()
                }
            val credentials = CloudCredentials(context)
            val id = java.util.UUID.randomUUID().toString()
            FileCloudServer(directory).use { server ->
                instrumentation.context.assets.open("rgb-gradient.png").use { input ->
                    server.original.outputStream().use { input.copyTo(it) }
                }
                val original = server.original.readBytes()
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
                try {
                    val library = PhotoLibrary(context)
                    val first = library.thumbnail(photo)
                    assertArrayEquals(original, first.readBytes())
                    assertEquals(1, server.derivativeTransfers)
                    repeat(4) { assertEquals(first, library.thumbnail(photo)) }
                    assertEquals(1, server.derivativeTransfers)
                    assertEquals(4, server.derivativeNotModified)
                    assertEquals(first, PhotoLibrary(context).thumbnail(photo))
                    assertEquals(1, server.derivativeTransfers)
                    assertEquals(5, server.derivativeNotModified)
                    val preview = library.thumbnail(photo, 2048)
                    assertNotEquals(first, preview)
                    assertArrayEquals(original, preview.readBytes())
                    assertEquals(2, server.derivativeTransfers)
                    assertEquals(preview, library.thumbnail(photo, 2048))
                    assertEquals(2, server.derivativeTransfers)

                    val bitmap = Bitmap.createBitmap(11, 7, Bitmap.Config.ARGB_8888)
                    bitmap.eraseColor(android.graphics.Color.RED)
                    server.derivative.outputStream().use {
                        bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)
                    }
                    bitmap.recycle()
                    val changed = library.thumbnail(photo)
                    assertNotEquals(first, changed)
                    assertArrayEquals(server.derivative.readBytes(), changed.readBytes())
                    assertEquals(3, server.derivativeTransfers)
                    assertEquals(changed, library.thumbnail(photo))
                    assertEquals(3, server.derivativeTransfers)
                    assertTrue(changed.delete())
                    val repaired = PhotoLibrary(context).thumbnail(photo)
                    assertArrayEquals(server.derivative.readBytes(), repaired.readBytes())
                    assertEquals(4, server.derivativeTransfers)
                    assertEquals(repaired, library.thumbnail(photo))
                    assertEquals(4, server.derivativeTransfers)
                    assertArrayEquals(original, server.original.readBytes())
                } finally {
                    credentials.remove(id)
                }
            }
            directory.deleteRecursively()
        }
}
