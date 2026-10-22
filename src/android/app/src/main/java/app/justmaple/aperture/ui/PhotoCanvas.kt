package app.justmaple.aperture.ui

import android.view.SurfaceHolder
import android.view.SurfaceView
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import app.justmaple.aperture.*
import kotlin.math.roundToInt
import kotlinx.coroutines.delay

@Composable
internal fun PhotoCanvas(
    model: MapleViewModel,
    state: MapleState,
    onHistogram: (Result<RgbHistogram>?) -> Unit,
    modifier: Modifier = Modifier,
    zoomState: CanvasZoomState = rememberCanvasZoomState(),
    badgeStartPadding: Dp = 12.dp,
    badgeBottomPadding: Dp = 12.dp,
    showCropOverlay: Boolean = false,
) {
    var view by remember { mutableStateOf<SurfaceView?>(null) }
    var surfaceVersion by remember { mutableIntStateOf(0) }
    val sampler = remember(state.selected?.key) { HistogramSampler() }
    DisposableEffect(sampler) { onDispose { sampler.close() } }
    val report by rememberUpdatedState(onHistogram)
    LaunchedEffect(state.selected?.key) { report(null) }
    LaunchedEffect(state.selected?.key, state.mode) { zoomState.reset() }
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
    val aspect = state.values["_aspect"]?.takeIf { it.isFinite() && it > 0f } ?: (3f / 2f)
    val imageDims =
        remember(aspect, state.values["_width"], state.values["_height"]) {
            val w = state.values["_width"]?.toInt()?.takeIf { it > 0 }
            val h = state.values["_height"]?.toInt()?.takeIf { it > 0 }
            if (w != null && h != null) w to h
            else if (aspect >= 1f) 2048 to (2048f / aspect).roundToInt().coerceAtLeast(1)
            else (2048f * aspect).roundToInt().coerceAtLeast(1) to 2048
        }
    val currentImageDims by rememberUpdatedState(imageDims)
    val currentMode by rememberUpdatedState(state.mode)

    BoxWithConstraints(
        modifier
            .clipToBounds()
            .pointerInput(state.selected?.key, state.mode) {
                detectCanvasZoomPanAndSwipe(
                    zoomState = zoomState,
                    imageDimensions = { currentImageDims },
                    allowSwipePaging = currentMode == PhotoMode.Preview,
                    onSwipePage = { delta -> model.openAdjacent(delta) },
                )
            }
            .testTag("photo-viewport"),
        contentAlignment = Alignment.Center,
    ) {
        val density = LocalDensity.current.density
        val viewportPxW = (maxWidth.value * density).coerceAtLeast(1f)
        val viewportPxH = (maxHeight.value * density).coerceAtLeast(1f)
        val zoomFactor =
            zoomState.zoomFactorOverFit(
                imageDims.first,
                imageDims.second,
                viewportPxW,
                viewportPxH,
            )
        val zoomModifier =
            if (zoomState.isZoomed)
                Modifier.graphicsLayer {
                    scaleX = zoomFactor
                    scaleY = zoomFactor
                    translationX = zoomState.panX
                    translationY = zoomState.panY
                }
            else Modifier

        if (state.mode == PhotoMode.Edit) {
            val width = minOf(maxWidth, maxHeight * aspect)
            val canvasHeight = width / aspect
            Box(Modifier.size(width, canvasHeight).then(zoomModifier)) {
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
                                        val wide =
                                            canvas.resources.configuration.isScreenWideColorGamut &&
                                                canvas.display?.isWideColorGamut == true
                                        model.surface(holder.surface, width, height, wide)
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
                        Modifier.fillMaxSize().semantics { contentDescription = "Photo canvas" },
                )
                if (showCropOverlay) {
                    val crop = remember(state.document) { state.document.cropRect() }
                    CropOverlay(
                        crop = crop,
                        onCropChange = model::applyCropRect,
                        modifier = Modifier.fillMaxSize(),
                    )
                }
            }
        } else
            state.selected?.let {
                PhotoThumbnail(
                    it,
                    model.library,
                    Modifier.fillMaxSize().padding(16.dp).then(zoomModifier),
                    fit = true,
                    revision = state.document.original,
                )
            }
        if (state.mode == PhotoMode.Edit && state.comparingBefore) {
            Surface(
                modifier =
                    Modifier.align(Alignment.TopStart)
                        .padding(top = 64.dp, start = badgeStartPadding)
                        .testTag("before-badge"),
                shape = RoundedCornerShape(6.dp),
                color = Color.Black.copy(alpha = 0.65f),
                border = BorderStroke(0.5.dp, MapleColors.primary.copy(alpha = 0.8f)),
            ) {
                Text(
                    text = "BEFORE",
                    modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
                    color = MapleColors.primary,
                    fontSize = 10.sp,
                    fontWeight = FontWeight.Bold,
                    fontFamily = FontFamily.Monospace,
                )
            }
        }
        if (state.selected != null) {
            CanvasZoomBadge(
                label =
                    zoomState.badgeLabel(
                        imageDims.first,
                        imageDims.second,
                        viewportPxW,
                        viewportPxH,
                    ),
                isZoomed = zoomState.isZoomed,
                onReset = zoomState::reset,
                modifier =
                    Modifier.align(Alignment.BottomStart)
                        .padding(start = badgeStartPadding, bottom = badgeBottomPadding),
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
