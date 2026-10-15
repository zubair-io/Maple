package app.justmaple.aperture

import android.graphics.BitmapFactory
import android.net.Uri
import androidx.test.filters.SdkSuppress
import androidx.test.platform.app.InstrumentationRegistry
import app.justmaple.aperture.data.PhotoLibrary
import java.io.File
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

@SdkSuppress(minSdkVersion = 31)
class LargePlatformPreviewTest {
    @Test
    fun fortyEightMegapixelHeifStagesOnlyRequestedPreviewPixels() = runBlocking {
        val i = InstrumentationRegistry.getInstrumentation()
        val context = i.targetContext
        val original = File.createTempFile("large-platform-", ".heic", context.filesDir)
        i.context.assets.open("large-48mp.heic").use { input ->
            original.outputStream().use { input.copyTo(it) }
        }
        val bytes = original.readBytes()
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(original.path, bounds)
        assertEquals(8000, bounds.outWidth)
        assertEquals(6000, bounds.outHeight)
        val library = PhotoLibrary(context)
        try {
            val photo = library.single(Uri.fromFile(original))
            val cache = File(context.cacheDir, "originals")
            val before = cache.listFiles().orEmpty().toSet()
            for (edge in listOf(512, 2048)) {
                library.withPreview(photo, edge) { staged ->
                    val tiff = FloatTiff(staged.readBytes())
                    val width = tiff.values(256).single()
                    val height = tiff.values(257).single()
                    assertTrue(width in edge / 2..edge && height in 1..edge)
                    assertEquals(4f / 3f, width.toFloat() / height, .003f)
                    assertTrue(staged.length() < edge.toLong() * edge * 12 + 1024 * 1024)
                }
            }
            val added =
                cache.listFiles().orEmpty().filter { it !in before && it.extension == "tiff" }
            assertEquals(2, added.size)
            assertTrue(added.all { it.length() < 2048L * 2048 * 12 + 1024 * 1024 })
            assertArrayEquals(bytes, original.readBytes())
        } finally {
            original.delete()
        }
    }
}
