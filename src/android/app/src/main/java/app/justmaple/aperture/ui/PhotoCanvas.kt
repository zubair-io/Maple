package app.justmaple.aperture.ui

import androidx.compose.foundation.Image
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.FilterQuality
import androidx.compose.ui.unit.IntOffset
import app.justmaple.aperture.data.NativeImageSize
import app.justmaple.aperture.data.nativeViewportRegion
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
    DisposableEffect(model, showCropOverlay) {
        model.setCropToolActive(showCropOverlay)
        onDispose { model.setCropToolActive(false) }
    }
    var view by remember { mutableStateOf<SurfaceView?>(null) }
    var surfaceVersion by remember { mutableIntStateOf(0) }
    val sampler = remember(state.selected?.key) { HistogramSampler() }
    DisposableEffect(sampler) { onDispose { sampler.close() } }
    val report by rememberUpdatedState(onHistogram)
    LaunchedEffect(state.selected?.key) { report(null) }
    LaunchedEffect(state.selected?.key, state.mode, showCropOverlay) { zoomState.reset() }
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
    val crop = remember(state.document) { state.document.cropRect() }
    val uncroppedAspect = state.uncroppedAspect()
    val fallbackAspect = if (showCropOverlay) uncroppedAspect else
        uncroppedAspect * (crop.right - crop.left).coerceAtLeast(0.001f) /
            (crop.bottom - crop.top).coerceAtLeast(0.001f)
    val aspect = state.nativeImageSize?.let { it.width.toFloat() / it.height } ?: fallbackAspect
    var adoptedSize by remember(state.selected?.key) { mutableStateOf<NativeImageSize?>(null) }
    val fallbackDims = if (fallbackAspect >= 1f) 2048 to (2048f / fallbackAspect).roundToInt().coerceAtLeast(1)
        else (2048f * fallbackAspect).roundToInt().coerceAtLeast(1) to 2048
    val imageDims = adoptedSize?.let { it.width to it.height } ?: fallbackDims
    val nativeReady = adoptedSize != null && adoptedSize == state.nativeImageSize
    val currentImageDims by rememberUpdatedState(imageDims)
    val currentMode by rememberUpdatedState(state.mode)

    BoxWithConstraints(
        modifier
            .clipToBounds()
            .pointerInput(state.selected?.key, state.mode, showCropOverlay) {
                if (showCropOverlay) return@pointerInput
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
        LaunchedEffect(state.nativeImageSize, state.selected?.key) {
            val size = state.nativeImageSize ?: return@LaunchedEffect
            if (adoptedSize == null) zoomState.adoptNativeDimensions(fallbackDims.first, fallbackDims.second,
                size.width, size.height, viewportPxW, viewportPxH)
            else if (adoptedSize != size) zoomState.reset()
            adoptedSize = size
        }
        LaunchedEffect(state.selected?.key, state.mode, state.document, state.comparingBefore,
            state.nativeSurfaceRevision,
            state.values.isEmpty(), adoptedSize, state.nativeImageSize, showCropOverlay,
            zoomState.pixelScale, zoomState.panX, zoomState.panY, viewportPxW, viewportPxH) {
            if (!zoomState.isZoomed || showCropOverlay || zoomState.pixelScale < 1f) {
                model.requestNativeDetail(null)
            } else if (!nativeReady) {
                model.prepareNativeDimensions()
            } else {
                model.requestNativeDetail(nativeViewportRegion(adoptedSize!!, viewportPxW, viewportPxH,
                    zoomState.pixelScale, zoomState.panX, zoomState.panY))
            }
        }
        DisposableEffect(model) { onDispose { model.cancelNativeDetail() } }
        val zoomFactor =
            zoomState.zoomFactorOverFit(
                imageDims.first,
                imageDims.second,
                viewportPxW,
                viewportPxH,
            )
        val zoomModifier =
            if (zoomState.isZoomed && nativeReady && !showCropOverlay)
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
                    CropOverlay(
                        crop = crop,
                        lockedAspect = state.lockedCropAspect(),
                        imageAspect = uncroppedAspect,
                        onCropChange = { model.applyCropRect(it, commit = false) },
                        onCropCommit = model::commitGesture,
                        modifier = Modifier.fillMaxSize(),
                    )
                }
            }
        } else
            state.selected?.let {
                PhotoThumbnail(
                    it,
                    model.library,
                    Modifier.fillMaxSize().then(zoomModifier),
                    fit = true,
                    revision = state.document.original,
                )
            }
        if (zoomState.isZoomed && nativeReady && !showCropOverlay) state.nativeDetail?.let { frame ->
            val scale = zoomState.effectiveScale(imageDims.first, imageDims.second, viewportPxW, viewportPxH)
            val left = viewportPxW / 2f + zoomState.panX - imageDims.first * scale / 2f + frame.region.x * scale
            val top = viewportPxH / 2f + zoomState.panY - imageDims.second * scale / 2f + frame.region.y * scale
            Image(frame.bitmap.asImageBitmap(), contentDescription = "Native detail preview",
                filterQuality = FilterQuality.None,
                modifier = Modifier.align(Alignment.TopStart)
                    .wrapContentSize(Alignment.TopStart, unbounded = true)
                    .offset { IntOffset(left.roundToInt(), top.roundToInt()) }
                    .requiredSize((frame.region.width * scale / density).dp, (frame.region.height * scale / density).dp)
                    .testTag("native-detail-preview"))
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
                label = when {
                    !zoomState.isZoomed && !nativeReady -> "FIT"
                    zoomState.isZoomed && !nativeReady -> if (state.nativeDimensionsLoading) "Reading original…" else "Preview only"
                    state.nativeDetailError != null && zoomState.isZoomed -> "${zoomState.badgeLabel(imageDims.first, imageDims.second, viewportPxW, viewportPxH)} · Preview only"
                    state.nativeDetailBusy && zoomState.isZoomed -> "${zoomState.badgeLabel(imageDims.first, imageDims.second, viewportPxW, viewportPxH)} · Refining"
                    else -> zoomState.badgeLabel(imageDims.first, imageDims.second, viewportPxW, viewportPxH)
                },
                isZoomed = zoomState.isZoomed,
                onReset = zoomState::reset,
                modifier =
                    Modifier.align(Alignment.BottomStart)
                        .padding(start = badgeStartPadding, bottom = badgeBottomPadding),
            )
        }
        if (zoomState.isZoomed && state.nativeDetailError != null) {
            Surface(Modifier.align(Alignment.BottomStart).padding(start = badgeStartPadding, bottom = badgeBottomPadding + 40.dp),
                color = Color.Black.copy(alpha = 0.75f), shape = RoundedCornerShape(6.dp)) {
                Text(state.nativeDetailError, modifier = Modifier.padding(8.dp).testTag("native-detail-error"),
                    color = MapleColors.muted, fontSize = 11.sp)
            }
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
