package app.justmaple.aperture

import android.net.Uri
import android.os.Build
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.justmaple.aperture.cloud.CloudCredentials
import app.justmaple.aperture.cloud.CloudServer
import app.justmaple.aperture.data.*
import java.io.File
import java.util.UUID
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Decision 12: one cloud grid tile. From API 31 the app asks the thumbnail route; below that it
 * downloads the whole original and renders locally. A loopback server on the device serves the
 * staged RAW as the original and its 512 px AVIF as the thumbnail.
 */
@TimingBenchmark
@RunWith(AndroidJUnit4::class)
class CloudThumbnailTimingTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext

    @Test
    fun oneCloudTile() {
        val raw = TimingRaw.file()
        val directory = File(context.cacheDir, "cloud-timing-${UUID.randomUUID()}").apply { mkdirs() }
        val credentials = CloudCredentials(context)
        val id = UUID.randomUUID().toString()
        TimingSources.backUp(context)
        FileCloudServer(directory).use { server ->
            raw.copyTo(server.original, overwrite = true)
            NativeBridge.sharedDerivative(raw.path, server.derivative.path, "", false)
            credentials.save(CloudServer(id, server.origin, "fixture-access-1", "fixture-refresh-1"))
            val uri =
                Uri.Builder()
                    .scheme("maple-cloud")
                    .authority(id)
                    .appendQueryParameter("address", "photos:2026/${server.original.name}")
                    .appendQueryParameter("path", server.original.path)
                    .build()
            val photo = Photo(uri, raw.name, raw.length(), 1, null)
            val thumbnails = File(context.cacheDir, "thumbnails")
            val originals = File(context.cacheDir, "originals")
            try {
                Timing.fact(
                    "cloud.fixture",
                    "sdk=${Build.VERSION.SDK_INT} route=${if (Build.VERSION.SDK_INT >= 31) "thumbnail" else "whole-original"} " +
                        "originalBytes=${server.original.length()} thumbnailBytes=${server.derivative.length()}",
                )
                fun tile(): Pair<Double, Long> {
                    thumbnails.deleteRecursively()
                    originals.deleteRecursively()
                    val servedBefore = server.responseBytes.get()
                    val millis =
                        Timing.millis {
                            runBlocking { PhotoLibrary(context).withThumbnail(photo, 512) { file, _ -> checkNotNull(file) } }
                        }.second
                    return millis to server.responseBytes.get() - servedBefore
                }
                tile()
                val measured = List(Timing.rounds) { tile() }
                val rounds = measured.map { it.first }
                val served = measured.map { it.second.toDouble() }
                if (Build.VERSION.SDK_INT >= 31) assertTrue(server.thumbCount > 0) else assertEquals(0, server.thumbCount)
                Timing.report("cloud.tile.sdk${Build.VERSION.SDK_INT}", "ms", rounds,
                    "loopback server on the device, so no network time is included")
                Timing.report("cloud.tile.sdk${Build.VERSION.SDK_INT}.bytes-served", "bytes", served,
                    "response body bytes the loopback server sent for one tile, counted in the server")
            } finally {
                credentials.remove(id)
                TimingSources.restore(context)
                directory.deleteRecursively()
                thumbnails.deleteRecursively()
                originals.deleteRecursively()
            }
        }
    }
}
