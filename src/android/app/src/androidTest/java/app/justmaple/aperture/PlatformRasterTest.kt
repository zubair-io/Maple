package app.justmaple.aperture

import android.graphics.Bitmap
import android.graphics.ColorSpace
import android.graphics.ImageDecoder
import android.net.Uri
import android.util.Half
import androidx.test.filters.SdkSuppress
import androidx.test.platform.app.InstrumentationRegistry
import app.justmaple.aperture.data.PhotoExport
import app.justmaple.aperture.data.PhotoLibrary
import app.justmaple.aperture.data.XmpDocument
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

@SdkSuppress(minSdkVersion = 31)
class PlatformRasterTest {
    @Test
    fun systemAvifSourceGamutAndPrecisionReachTheCoreUnchanged() = runBlocking {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val library = PhotoLibrary(context)
        for (name in listOf("wide-p3.avif", "avif-10.avif")) {
            val original = File.createTempFile("platform-color-", ".avif", context.filesDir)
            instrumentation.context.assets.open(name).use { input ->
                original.outputStream().use { input.copyTo(it) }
            }
            val originalBytes = original.readBytes()
            val bitmap =
                ImageDecoder.decodeBitmap(ImageDecoder.createSource(original)) { d, _, _ ->
                    d.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
                    d.setUnpremultipliedRequired(true)
                }
            try {
                val rgb = bitmap.colorSpace as ColorSpace.Rgb
                val pcs = ColorSpace.adapt(rgb, ColorSpace.ILLUMINANT_D50) as ColorSpace.Rgb
                val decoded =
                    ByteBuffer.allocate(bitmap.allocationByteCount).order(ByteOrder.nativeOrder())
                bitmap.copyPixelsToBuffer(decoded)
                val photo = library.single(Uri.fromFile(original))
                library.withPreview(photo, 8) { preview ->
                    val header = FloatTiff(preview.readBytes())
                    assertTrue(header.values(256).single() <= 8 && header.values(257).single() <= 8)
                }
                library.withOriginal(photo) { staged ->
                    assertEquals("tiff", staged.extension)
                    val tiff = FloatTiff(staged.readBytes())
                    assertEquals(bitmap.width, tiff.values(256).single())
                    assertEquals(bitmap.height, tiff.values(257).single())
                    assertTrue(tiff.values(258).all { it == 32 })
                    assertTrue(tiff.values(339).all { it == 3 }) // IEEE floating point
                    val icc =
                        ByteBuffer.wrap(tiff.values(34675).map { it.toByte() }.toByteArray())
                            .order(ByteOrder.BIG_ENDIAN)
                    for ((column, signature) in listOf("rXYZ", "gXYZ", "bXYZ").withIndex()) {
                        val offset = iccOffset(icc, signature)
                        for (row in 0..2) assertEquals(
                            pcs.transform[column * 3 + row],
                            icc.getInt(offset + 8 + row * 4) / 65536f,
                            0.00002f,
                        )
                    }
                    val transfer = rgb.transferParameters!!
                    val trc = iccOffset(icc, "rTRC")
                    assertEquals(4, icc.getShort(trc + 8).toInt())
                    val expectedTrc =
                        listOf(
                            transfer.g,
                            transfer.a,
                            transfer.b,
                            transfer.c,
                            transfer.d,
                            transfer.e,
                            transfer.f,
                        )
                    for ((index, value) in expectedTrc.withIndex()) assertEquals(
                        value,
                        icc.getInt(trc + 12 + index * 4) / 65536.0,
                        0.00002,
                    )
                    val offsets = tiff.values(273)
                    val lengths = tiff.values(279)
                    val floats =
                        offsets.zip(lengths).flatMap { (offset, size) ->
                            (offset until offset + size step 4).map { tiff.bytes.getFloat(it) }
                        }
                    assertEquals(bitmap.width * bitmap.height * 3, floats.size)
                    var finePrecision = false
                    for (y in 0 until bitmap.height) {
                        for (x in 0 until bitmap.width) {
                            for (channel in 0..2) {
                                val expected = decodedChannel(bitmap, decoded, x, y, channel)
                                val actual = floats[(y * bitmap.width + x) * 3 + channel]
                                assertEquals("$name ($x,$y) channel $channel", expected, actual, 0f)
                                finePrecision =
                                    finePrecision ||
                                        kotlin.math.abs(
                                            actual * 255f - kotlin.math.round(actual * 255f)
                                        ) > 0.01f
                            }
                        }
                    }
                    if (name == "wide-p3.avif")
                        assertTrue("P3 source gamut must survive the OS decoder", rgb.isWideGamut)
                    assertTrue("Fixture must exercise more than eight-bit precision", finePrecision)
                }
                val exported =
                    File.createTempFile("platform-full-export-", ".jpg", context.cacheDir)
                try {
                    PhotoExport(context, library)
                        .write(photo, XmpDocument(), Uri.fromFile(exported), false)
                    val dimensions =
                        android.graphics.BitmapFactory.Options().apply { inJustDecodeBounds = true }
                    android.graphics.BitmapFactory.decodeFile(exported.path, dimensions)
                    assertEquals(bitmap.width, dimensions.outWidth)
                    assertEquals(bitmap.height, dimensions.outHeight)
                } finally {
                    exported.delete()
                }
                assertArrayEquals(originalBytes, original.readBytes())
            } finally {
                bitmap.recycle()
                original.delete()
            }
        }
    }

    private fun iccOffset(icc: ByteBuffer, signature: String): Int {
        val tag =
            (0 until icc.getInt(128))
                .map { 132 + it * 12 }
                .first { offset ->
                    String(icc.array(), offset, 4, Charsets.US_ASCII) == signature
                }
        return icc.getInt(tag + 4)
    }

    private fun decodedChannel(
        bitmap: Bitmap,
        bytes: ByteBuffer,
        x: Int,
        y: Int,
        channel: Int,
    ): Float {
        val offset = y * bitmap.rowBytes + x * if (bitmap.config == Bitmap.Config.RGBA_F16) 8 else 4
        return when {
            bitmap.config == Bitmap.Config.RGBA_F16 ->
                Half.toFloat(bytes.getShort(offset + channel * 2))
            bitmap.config == Bitmap.Config.ARGB_8888 ->
                (bytes.get(offset + channel).toInt() and 255) / 255f
            android.os.Build.VERSION.SDK_INT >= 33 && bitmap.config == Bitmap.Config.RGBA_1010102 ->
                ((bytes.getInt(offset) ushr (channel * 10)) and 1023) / 1023f
            else -> error("Unsupported bitmap ${bitmap.config}")
        }
    }
}
