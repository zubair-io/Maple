package app.justmaple.aperture.ui

import android.view.SurfaceHolder
import android.view.SurfaceView
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import app.justmaple.aperture.*
import kotlinx.coroutines.delay

@Composable
internal fun PhotoCanvas(
    model: MapleViewModel,
    state: MapleState,
    onHistogram: (Result<RgbHistogram>?) -> Unit,
    modifier: Modifier = Modifier,
) {
    var view by remember { mutableStateOf<SurfaceView?>(null) }
    var surfaceVersion by remember { mutableIntStateOf(0) }
    val sampler = remember(state.selected?.key) { HistogramSampler() }
    DisposableEffect(sampler) { onDispose { sampler.close() } }
    val report by rememberUpdatedState(onHistogram)
    LaunchedEffect(state.selected?.key) { report(null) }
    LaunchedEffect(
        state.selected?.key,
        state.values,
        state.document,
        state.rendering,
        surfaceVersion,
    ) {
        val surface = view?.holder?.surface
        if (
            state.mode == PhotoMode.Edit &&
                !state.rendering &&
                state.values.isNotEmpty() &&
                surface?.isValid == true
        ) {
            delay(300)
            var sampled: RgbHistogram? = null
            repeat(5) {
                if (sampled == null) {
                    sampled = sampler.read(surface)
                    if (sampled == null) delay(100)
                }
            }
            report(
                sampled?.let { Result.success(it) }
                    ?: Result.failure(IllegalStateException("Histogram capture is unavailable"))
            )
        }
    }
    BoxWithConstraints(
        modifier.clipToBounds().testTag("photo-viewport"),
        contentAlignment = Alignment.Center,
    ) {
        if (state.mode == PhotoMode.Edit) {
            val aspect = state.values["_aspect"]?.takeIf { it.isFinite() && it > 0f } ?: (3f / 2f)
            val width = minOf(maxWidth, maxHeight * aspect)
            AndroidView(
                factory = { context ->
                    SurfaceView(context).also { canvas ->
                        view = canvas
                        canvas.holder.addCallback(
                            object : SurfaceHolder.Callback {
                                override fun surfaceCreated(holder: SurfaceHolder) = Unit

                                override fun surfaceChanged(
                                    holder: SurfaceHolder,
                                    format: Int,
                                    width: Int,
                                    height: Int,
                                ) {
                                    model.surface(holder.surface, width, height)
                                    surfaceVersion++
                                }

                                override fun surfaceDestroyed(holder: SurfaceHolder) {
                                    model.surface(null, 0, 0)
                                    surfaceVersion++
                                }
                            }
                        )
                    }
                },
                modifier =
                    Modifier.size(width, width / aspect).semantics {
                        contentDescription = "Photo canvas"
                    },
            )
        } else
            state.selected?.let {
                PhotoThumbnail(
                    it,
                    model.library,
                    Modifier.fillMaxSize().padding(16.dp),
                    fit = true,
                    revision = state.document.original,
                )
            }
        if (state.loading || state.rendering)
            MapleGlass {
                Row(Modifier.padding(16.dp), verticalAlignment = Alignment.CenterVertically) {
                    CircularProgressIndicator(
                        Modifier.size(20.dp),
                        color = MapleColors.primary,
                        strokeWidth = 2.dp,
                    )
                    Spacer(Modifier.width(12.dp))
                    Text(if (state.rendering) "Developing…" else "Opening…")
                }
            }
    }
}
