package app.justmaple.aperture.data

import android.graphics.ColorSpace
import android.graphics.ImageDecoder
import java.io.File

/** Decode without an sRGB/8-bit intermediate; the core owns scene conversion. */
internal object PlatformRasterStage {
    fun write(source: File, destination: File) {
        val bitmap =
            ImageDecoder.decodeBitmap(ImageDecoder.createSource(source)) { decoder, _, _ ->
                decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
                // Keep the decoder's source gamut/precision. AVIF's conversion to
                // a requested extended-sRGB target can clip or mislabel its pixels.
                decoder.setUnpremultipliedRequired(true)
            }
        try {
            val rgb =
                bitmap.colorSpace as? ColorSpace.Rgb
                    ?: error("The system decoder did not provide an RGB color profile")
            val transfer =
                rgb.transferParameters ?: error("This photo's HDR transfer curve is not supported")
            check(transfer.g > 0) { "This photo's HDR transfer curve is not supported" }
            // ICC uses D50 PCS colorants. This adapts metadata, not image pixels.
            val pcs = ColorSpace.adapt(rgb, ColorSpace.ILLUMINANT_D50) as ColorSpace.Rgb
            val profile =
                pcs.transform +
                    floatArrayOf(
                        transfer.g.toFloat(),
                        transfer.a.toFloat(),
                        transfer.b.toFloat(),
                        transfer.c.toFloat(),
                        transfer.d.toFloat(),
                        transfer.e.toFloat(),
                        transfer.f.toFloat(),
                    )
            NativeBridge.stageBitmap(bitmap, destination.absolutePath, profile)
        } finally {
            bitmap.recycle()
        }
    }
}
