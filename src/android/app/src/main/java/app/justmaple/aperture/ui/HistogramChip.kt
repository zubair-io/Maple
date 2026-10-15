package app.justmaple.aperture.ui

import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import android.view.PixelCopy
import android.view.Surface
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine
import kotlin.math.ln
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

internal data class RgbHistogram(val channels: List<List<Float>>)

/** Samples only after idle; never reads back or allocates inside the GPU render loop. */
internal class HistogramSampler {
    private val bitmap = Bitmap.createBitmap(256, 128, Bitmap.Config.ARGB_8888)
    private val pixels = IntArray(256 * 128)
    private val mutex = Mutex()
    private val handler = Handler(Looper.getMainLooper())
    private var busy = false
    private var closed = false

    suspend fun read(surface: Surface): RgbHistogram? = mutex.withLock {
        if (closed || !surface.isValid) return@withLock null
        busy = true
        try {
            // PixelCopy owns the destination until its callback, even on cancellation.
            val result =
                withContext(NonCancellable) {
                    suspendCoroutine { continuation ->
                        try {
                            PixelCopy.request(surface, bitmap, { continuation.resume(it) }, handler)
                        } catch (_: IllegalArgumentException) {
                            continuation.resume(PixelCopy.ERROR_SOURCE_INVALID)
                        }
                    }
                }
            currentCoroutineContext().ensureActive()
            if (closed || result != PixelCopy.SUCCESS) return@withLock null
            withContext(Dispatchers.Default) {
                bitmap.getPixels(pixels, 0, 256, 0, 0, 256, 128)
                val bins = List(3) { IntArray(64) }
                for (pixel in pixels) for (channel in 0..2) bins[channel][
                    (pixel ushr (16 - channel * 8) and 255) / 4]++
                val maximum = ln(1f + bins.maxOf { it.max() })
                RgbHistogram(
                    bins.map { row -> row.map { ln(1f + it) / maximum.coerceAtLeast(1f) } }
                )
            }
        } finally {
            busy = false
            if (closed) bitmap.recycle()
        }
    }

    fun close() {
        closed = true
        if (!busy) bitmap.recycle()
    }
}

@Composable
internal fun HistogramChip(result: Result<RgbHistogram>?) {
    val histogram = result?.getOrNull()
    Box(
        Modifier.fillMaxSize().semantics {
            contentDescription = "RGB histogram"
            stateDescription =
                if (result == null) "Updating" else if (result.isSuccess) "Ready" else "Unavailable"
        },
        contentAlignment = Alignment.Center,
    ) {
        if (result?.isFailure == true)
            Text("Histogram unavailable", color = MapleColors.muted, fontSize = 9.sp)
        else if (histogram == null)
            CircularProgressIndicator(
                Modifier.size(14.dp),
                strokeWidth = 1.dp,
                color = MapleColors.muted,
            )
        else
            Canvas(Modifier.fillMaxSize().padding(horizontal = 12.dp, vertical = 6.dp)) {
                val colors = listOf(Color.Red, Color.Green, Color.Blue)
                histogram.channels.forEachIndexed { channel, bins ->
                    val path = Path()
                    bins.forEachIndexed { index, value ->
                        val x = size.width * index / (bins.size - 1)
                        val y = size.height * (1 - value)
                        if (index == 0) path.moveTo(x, y) else path.lineTo(x, y)
                    }
                    drawPath(path, colors[channel].copy(alpha = .8f), style = Stroke(1.dp.toPx()))
                }
            }
    }
}
