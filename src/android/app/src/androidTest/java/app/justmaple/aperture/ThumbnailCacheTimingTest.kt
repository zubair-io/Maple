package app.justmaple.aperture

import android.graphics.BitmapFactory
import android.os.Build
import android.os.ParcelFileDescriptor
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.justmaple.aperture.data.*
import java.io.File
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The eviction runs [trimCache] on synthetic entries written to private folders under the app's cache
 * directory; it never touches the app's real thumbnail cache.
 */
@TimingBenchmark
@RunWith(AndroidJUnit4::class)
class ThumbnailCacheTimingTest {
    private companion object {
        const val INDEX_BYTES = 100
        const val HEADROOM_BYTES = 20_000
    }

    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    private fun addEntry(folder: File, index: Int, payloadBytes: Int, modified: Long) {
        val key = PhotoLibrary.digest("timing-key-$index")
        val content = PhotoLibrary.digest("timing-content-$index")
        File(folder, "cloud-$key.json").apply {
            writeText("""{"content":"$content","etag":"e$index"}""")
            setLastModified(modified)
        }
        File(folder, "cloud-$key-$content.avif").apply {
            writeBytes(ByteArray(payloadBytes))
            setLastModified(modified)
        }
    }

    private fun payload(files: Int, share: Double) = (PhotoLibrary.THUMBNAIL_BYTES * share / files).toInt() - INDEX_BYTES

    @Test
    fun trimmingAThumbnailCacheAtAndUnderItsBudget() {
        val entries = 1_600
        val folder = File(context.cacheDir, "timing-thumbnails-full").apply { deleteRecursively(); mkdirs() }
        val under = File(context.cacheDir, "timing-thumbnails-under").apply { deleteRecursively(); mkdirs() }
        try {
            val start = System.currentTimeMillis() - 10_000_000
            val fullPayload = ((PhotoLibrary.THUMBNAIL_BYTES - HEADROOM_BYTES) / (entries - 1)).toInt() - INDEX_BYTES
            repeat(entries - 1) { addEntry(folder, it, fullPayload, start + it * 1000L) }
            repeat(entries) { addEntry(under, it, payload(entries, .25), start + it * 1000L) }
            Timing.fact("cache.setup", "entries=$entries files=${folder.listFiles()!!.size} bytes=${folder.listFiles()!!.sumOf { it.length() }} budget=${PhotoLibrary.THUMBNAIL_BYTES}")
            val over = mutableListOf<Double>()
            val within = mutableListOf<Double>()
            repeat(Timing.rounds) { round ->
                val index = entries + round
                addEntry(folder, index, fullPayload, System.currentTimeMillis())
                val newest = File(folder, "cloud-${PhotoLibrary.digest("timing-key-$index")}-${PhotoLibrary.digest("timing-content-$index")}.avif")
                val before = folder.listFiles()!!.size
                over += Timing.millis { trimCache(folder, PhotoLibrary.THUMBNAIL_BYTES, setOf(newest)) }.second
                assertTrue("An over-budget trim must evict", folder.listFiles()!!.size < before)
                within += Timing.millis { trimCache(under, PhotoLibrary.THUMBNAIL_BYTES, emptySet()) }.second
            }
            Timing.report("cache.trim.over-budget-one-eviction", "ms", over, "1,600 thumbnails with index files (3,200 files) at 64 MiB; trim after one insert evicts the oldest")
            Timing.report("cache.trim.within-budget", "ms", within, "3,200 files, 25% of the budget: the early return from wave 1")
        } finally {
            folder.deleteRecursively()
            under.deleteRecursively()
        }
    }

    @Test
    fun decodingA512PixelTileAtFullSizeAndHalfSize() {
        val raw = TimingRaw.file()
        val jpeg = File(context.cacheDir, "timing-tile.jpg")
        val avif = File(context.cacheDir, "timing-tile.avif")
        try {
            NativeBridge.thumbnail(raw.path, jpeg.path, "", 512)
            val files = mutableListOf("jpeg" to jpeg)
            if (Build.VERSION.SDK_INT >= 31) {
                NativeBridge.sharedDerivative(raw.path, avif.path, "", false)
                files += "avif" to avif
            }
            for ((label, file) in files) {
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                BitmapFactory.decodeFile(file.path, bounds)
                Timing.fact("decode.$label.file", "bytes=${file.length()} width=${bounds.outWidth} height=${bounds.outHeight}")
                for (sample in listOf(1, 2)) {
                    var bitmapBytes = 0
                    val decodes = 40
                    val rounds = List(Timing.rounds) {
                        ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY).use { descriptor ->
                            Timing.millis {
                                repeat(decodes) {
                                    val options = BitmapFactory.Options().apply { inSampleSize = sample }
                                    val bitmap = checkNotNull(BitmapFactory.decodeFileDescriptor(descriptor.fileDescriptor, null, options))
                                    bitmapBytes = bitmap.allocationByteCount
                                    bitmap.recycle()
                                }
                            }.second / decodes
                        }
                    }
                    Timing.report("decode.$label.sample-$sample", "ms_per_decode", rounds, "decodeFileDescriptor, bitmap bytes=$bitmapBytes")
                }
            }
        } finally {
            jpeg.delete()
            avif.delete()
        }
    }
}
