package app.justmaple.aperture

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.justmaple.aperture.data.*
import app.justmaple.aperture.ui.*
import java.io.File
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ConfiguredExportTest {
    @Test
    fun selectedFormatsAndColorSpacesReachTheVerifiedDestination() = runBlocking {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val input = File.createTempFile("configured-input-", ".png", context.cacheDir)
        instrumentation.context.assets.open("rgb-gradient.png").use { source -> input.outputStream().use(source::copyTo) }
        val original = input.readBytes()
        val photo = Photo(Uri.fromFile(input), input.name, input.length(), input.lastModified(), null)
        val exporter = PhotoExport(context, PhotoLibrary(context))
        try {
            for (format in ExportFormat.entries) {
                for (space in ExportColorSpace.entries) {
                    val output = File.createTempFile("configured-output-", ".${format.extension}", context.cacheDir)
                    try {
                        exporter.write(photo, XmpDocument(), Uri.fromFile(output), false,
                            ExportOptions(format, 75, 12, space))
                        val bytes = output.readBytes()
                        assertTrue("An export must contain real encoded bytes", bytes.size > 32)
                        if (format == ExportFormat.TIFF) {
                            assertTrue(bytes.take(4) == listOf<Byte>(73, 73, 42, 0) || bytes.take(4) == listOf<Byte>(77, 77, 0, 42))
                        } else {
                            val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                            BitmapFactory.decodeFile(output.path, bounds)
                            assertEquals(12, maxOf(bounds.outWidth, bounds.outHeight))
                            if (format == ExportFormat.JPEG || format == ExportFormat.PNG) {
                                assertEquals(space == ExportColorSpace.DISPLAY_P3, bounds.outColorSpace?.isWideGamut)
                            }
                        }
                        assertArrayEquals(original, input.readBytes())
                    } finally { output.delete() }
                }
            }
        } finally { input.delete() }
    }

    @Test
    fun nativeSizingReachesTheSelectedEdgeWithoutUpscaling() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val exporter = PhotoExport(context, PhotoLibrary(context))
        for (width in listOf(3000, 6000, 8191, 11648)) {
            val input = File.createTempFile("sizing-input-", ".png", context.cacheDir)
            val output = File.createTempFile("sizing-output-", ".png", context.cacheDir)
            val bitmap = Bitmap.createBitmap(width, 32, Bitmap.Config.ARGB_8888).apply { eraseColor(android.graphics.Color.rgb(20, 40, 60)) }
            try {
                input.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
                val photo = Photo(Uri.fromFile(input), input.name, input.length(), input.lastModified(), null)
                exporter.write(photo, XmpDocument(), Uri.fromFile(output), false,
                    ExportOptions(format = ExportFormat.PNG, maxEdge = 4096))
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeFile(output.path, bounds)
                assertEquals("source width $width", minOf(width, 4096), bounds.outWidth)
            } finally {
                bitmap.recycle()
                input.delete()
                output.delete()
            }
        }
    }
}
