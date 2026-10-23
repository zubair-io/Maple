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
import app.justmaple.aperture.data.NativeBridge
import org.json.JSONArray
import org.json.JSONObject
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.drawscope.DrawScope
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

enum class ScopeMode(val label: String) {
    Histogram("Histogram"),
    Waveform("Waveform"),
    Parade("RGB Parade"),
    Vectorscope("Vectorscope"),
}

internal data class RgbHistogram(
    val channels: List<List<Float>>,
    val columns: Int,
    val bins: Int,
    val waveformLuma: List<Float> = emptyList(),
    val paradeR: List<Float> = emptyList(),
    val paradeG: List<Float> = emptyList(),
    val paradeB: List<Float> = emptyList(),
    val vectorscopeBins: Int = 0,
    val vectorscope: List<Float> = emptyList(),
) {
    companion object {
        fun fromArgbPixels(pixels: IntArray, width: Int, height: Int): RgbHistogram {
            val sample = JSONObject(NativeBridge.scopePixels(pixels, width, height))
            fun values(array: JSONArray) = List(array.length()) { array.getDouble(it).toFloat() }
            val channels = sample.getJSONArray("channels")
            val vsBins = sample.optInt("vectorscopeBins", 0)
            val vsArray = sample.optJSONArray("vectorscope")
            return RgbHistogram(
                channels = List(channels.length()) { values(channels.getJSONArray(it)) },
                columns = sample.getInt("columns"), bins = sample.getInt("bins"),
                waveformLuma = values(sample.getJSONArray("waveformLuma")),
                paradeR = values(sample.getJSONArray("paradeR")),
                paradeG = values(sample.getJSONArray("paradeG")),
                paradeB = values(sample.getJSONArray("paradeB")),
                vectorscopeBins = vsBins,
                vectorscope = if (vsArray != null) values(vsArray) else emptyList(),
            )
        }
    }
}

private fun DrawScope.scopeDensity(values: List<Float>, columns: Int, bins: Int,
    startX: Float, plotWidth: Float, color: Color) {
    if (columns <= 0 || bins <= 0 || values.size != columns * bins) return
    val cellW = plotWidth / columns
    val cellH = size.height / bins
    values.forEachIndexed { index, density ->
        if (density > 0f) {
            drawRect(color.copy(alpha = (0.12f + density * 0.78f).coerceIn(0f, 1f)),
                topLeft = Offset(startX + (index / bins) * cellW, size.height - (index % bins + 1) * cellH),
                size = Size(cellW + 0.5f, cellH + 0.5f))
        }
    }
}

private fun DrawScope.vectorscopePlot(values: List<Float>, grid: Int) {
    val diameter = minOf(size.width, size.height)
    val radius = diameter / 2f
    val center = Offset(size.width / 2f, size.height / 2f)
    drawCircle(
        color = Color.White.copy(alpha = 0.2f),
        radius = radius,
        center = center,
        style = Stroke(width = 0.75.dp.toPx()),
    )
    drawLine(
        color = Color.White.copy(alpha = 0.15f),
        start = Offset(center.x - radius, center.y),
        end = Offset(center.x + radius, center.y),
        strokeWidth = 0.5.dp.toPx(),
    )
    drawLine(
        color = Color.White.copy(alpha = 0.15f),
        start = Offset(center.x, center.y - radius),
        end = Offset(center.x, center.y + radius),
        strokeWidth = 0.5.dp.toPx(),
    )
    if (grid <= 0 || values.size != grid * grid) return
    val cell = diameter / grid
    val left = center.x - radius
    val top = center.y - radius
    values.forEachIndexed { index, density ->
        if (density > 0f) {
            val row = index / grid
            val col = index % grid
            drawRect(
                color = MapleColors.primary.copy(alpha = (0.18f + density * 0.82f).coerceIn(0f, 1f)),
                topLeft = Offset(left + col * cell, top + (grid - 1 - row) * cell),
                size = Size(cell + 0.5f, cell + 0.5f),
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
            ScopeMode.Parade -> ScopeMode.Vectorscope
            ScopeMode.Vectorscope -> ScopeMode.Histogram
        }
    Box(
        Modifier.fillMaxSize()
            .clickable(enabled = histogram != null) { mode = nextMode }
            .semantics {
                contentDescription = mode.label
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
                    ScopeMode.Waveform -> scopeDensity(histogram.waveformLuma,
                        histogram.columns, histogram.bins, 0f, size.width, MapleColors.primary)
                    ScopeMode.Parade -> {
                        val bands = listOf(histogram.paradeR to Color.Red,
                            histogram.paradeG to Color.Green, histogram.paradeB to Color.Blue)
                        val bandWidth = size.width / 3f
                        bands.forEachIndexed { index, (values, color) ->
                            val startX = index * bandWidth
                            if (index > 0) drawLine(Color.White.copy(alpha = 0.15f),
                                Offset(startX, 0f), Offset(startX, size.height), 0.5.dp.toPx())
                            scopeDensity(values, histogram.columns, histogram.bins,
                                startX, bandWidth - 2.dp.toPx(), color)
                        }
                    }
                    ScopeMode.Vectorscope ->
                        vectorscopePlot(histogram.vectorscope, histogram.vectorscopeBins)
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
