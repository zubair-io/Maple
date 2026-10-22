package app.justmaple.aperture.ui

import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import android.view.PixelCopy
import android.view.Surface
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.coroutines.resume
import kotlin.coroutines.suspendCoroutine
import kotlin.math.ln
import kotlin.math.min
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

enum class ScopeMode(val label: String) {
    Histogram("Histogram"),
    Waveform("Waveform"),
    Parade("RGB Parade"),
}

internal data class RgbHistogram(
    val channels: List<List<Float>>,
    val waveformLuma: List<Float> = emptyList(),
    val paradeR: List<Float> = emptyList(),
    val paradeG: List<Float> = emptyList(),
    val paradeB: List<Float> = emptyList(),
) {
    companion object {
        const val COLUMNS = 64
        const val BINS = 64

        fun fromArgbPixels(pixels: IntArray, width: Int, height: Int): RgbHistogram {
            val cols = if (width in 1 until COLUMNS) width else COLUMNS
            val bins = List(3) { IntArray(BINS) }
            val sumR = IntArray(cols)
            val sumG = IntArray(cols)
            val sumB = IntArray(cols)
            val count = IntArray(cols)
            if (width > 0 && height > 0 && pixels.size >= width * height) {
                for (y in 0 until height) {
                    val rowOffset = y * width
                    for (x in 0 until width) {
                        val pixel = pixels[rowOffset + x]
                        val r = (pixel ushr 16) and 255
                        val g = (pixel ushr 8) and 255
                        val b = pixel and 255
                        bins[0][r / 4]++
                        bins[1][g / 4]++
                        bins[2][b / 4]++
                        val col = min(cols - 1, x * cols / width)
                        sumR[col] += r
                        sumG[col] += g
                        sumB[col] += b
                        count[col]++
                    }
                }
            }
            val maximum = ln(1f + (bins.maxOfOrNull { it.maxOrNull() ?: 0 } ?: 0))
            val normBins =
                bins.map { row -> row.map { ln(1f + it) / maximum.coerceAtLeast(1f) } }
            val pR =
                List(COLUMNS) { c ->
                    val src = min(cols - 1, c * cols / COLUMNS)
                    if (count[src] > 0) sumR[src].toFloat() / (count[src] * 255f) else 0f
                }
            val pG =
                List(COLUMNS) { c ->
                    val src = min(cols - 1, c * cols / COLUMNS)
                    if (count[src] > 0) sumG[src].toFloat() / (count[src] * 255f) else 0f
                }
            val pB =
                List(COLUMNS) { c ->
                    val src = min(cols - 1, c * cols / COLUMNS)
                    if (count[src] > 0) sumB[src].toFloat() / (count[src] * 255f) else 0f
                }
            val luma =
                List(COLUMNS) { c ->
                    (0.2126f * pR[c] + 0.7152f * pG[c] + 0.0722f * pB[c]).coerceIn(0f, 1f)
                }
            return RgbHistogram(
                channels = normBins,
                waveformLuma = luma,
                paradeR = pR,
                paradeG = pG,
                paradeB = pB,
            )
        }
    }
}

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
                RgbHistogram.fromArgbPixels(pixels, 256, 128)
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
internal fun HistogramChip(
    result: Result<RgbHistogram>?,
    initialMode: ScopeMode = ScopeMode.Histogram,
) {
    var mode by rememberSaveable { mutableStateOf(initialMode) }
    val histogram = result?.getOrNull()
    val nextMode =
        when (mode) {
            ScopeMode.Histogram -> ScopeMode.Waveform
            ScopeMode.Waveform -> ScopeMode.Parade
            ScopeMode.Parade -> ScopeMode.Histogram
        }
    Box(
        Modifier.fillMaxSize()
            .clickable(enabled = histogram != null) { mode = nextMode }
            .semantics {
                contentDescription = "RGB histogram"
                stateDescription =
                    if (result == null) "Updating"
                    else if (result.isSuccess) "Ready" else "Unavailable"
            }
            .testTag("editor-scopes-chip"),
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
        else {
            Canvas(Modifier.fillMaxSize().padding(horizontal = 12.dp, vertical = 6.dp)) {
                when (mode) {
                    ScopeMode.Histogram -> {
                        val colors = listOf(Color.Red, Color.Green, Color.Blue)
                        histogram.channels.forEachIndexed { channel, bins ->
                            if (bins.size >= 2) {
                                val path = Path()
                                bins.forEachIndexed { index, value ->
                                    val x = size.width * index / (bins.size - 1)
                                    val y = size.height * (1 - value)
                                    if (index == 0) path.moveTo(x, y) else path.lineTo(x, y)
                                }
                                drawPath(
                                    path,
                                    colors[channel].copy(alpha = .8f),
                                    style = Stroke(1.dp.toPx()),
                                )
                            }
                        }
                    }
                    ScopeMode.Waveform -> {
                        val cols = histogram.waveformLuma
                        if (cols.size >= 2) {
                            val path = Path()
                            cols.forEachIndexed { index, luma ->
                                val x = size.width * index / (cols.size - 1)
                                val y = size.height * (1f - luma.coerceIn(0f, 1f))
                                if (index == 0) path.moveTo(x, y) else path.lineTo(x, y)
                            }
                            drawPath(
                                path,
                                MapleColors.primary.copy(alpha = 0.9f),
                                style = Stroke(1.25.dp.toPx()),
                            )
                        }
                    }
                    ScopeMode.Parade -> {
                        val bands =
                            listOf(
                                histogram.paradeR to Color.Red,
                                histogram.paradeG to Color.Green,
                                histogram.paradeB to Color.Blue,
                            )
                        val bandWidth = size.width / 3f
                        bands.forEachIndexed { bIdx, (cols, color) ->
                            val startX = bIdx * bandWidth
                            if (bIdx > 0) {
                                drawLine(
                                    color = Color.White.copy(alpha = 0.15f),
                                    start = Offset(startX, 0f),
                                    end = Offset(startX, size.height),
                                    strokeWidth = 0.5.dp.toPx(),
                                )
                            }
                            if (cols.size >= 2) {
                                val path = Path()
                                cols.forEachIndexed { index, v ->
                                    val x = startX + (bandWidth - 2.dp.toPx()) * index / (cols.size - 1)
                                    val y = size.height * (1f - v.coerceIn(0f, 1f))
                                    if (index == 0) path.moveTo(x, y) else path.lineTo(x, y)
                                }
                                drawPath(
                                    path,
                                    color.copy(alpha = 0.85f),
                                    style = Stroke(1.dp.toPx()),
                                )
                            }
                        }
                    }
                }
            }
            if (mode != ScopeMode.Histogram) {
                Text(
                    mode.label.uppercase(),
                    modifier = Modifier.align(Alignment.TopEnd).padding(end = 10.dp, top = 2.dp),
                    color = MapleColors.muted,
                    fontSize = 7.sp,
                    fontFamily = FontFamily.Monospace,
                )
            }
        }
    }
}
