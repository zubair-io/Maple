package app.justmaple.aperture.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChanged
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.justmaple.aperture.MapleState
import app.justmaple.aperture.MapleViewModel
import app.justmaple.aperture.data.XmpDocument
import java.util.Locale
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

data class CropRect(
    val top: Float = 0f,
    val left: Float = 0f,
    val bottom: Float = 1f,
    val right: Float = 1f,
    val angle: Float = 0f,
) {
    val isIdentityRect: Boolean
        get() =
            abs(top) < 1e-4f &&
                abs(left) < 1e-4f &&
                abs(bottom - 1f) < 1e-4f &&
                abs(right - 1f) < 1e-4f

    val isIdentity: Boolean
        get() = isIdentityRect && abs(angle) < 1e-4f
}

enum class CropAspectId(val rawId: String, val label: String, val fixedRatio: Float?) {
    Free("free", "Free", null),
    Original("original", "Original", null),
    Square("1:1", "1:1", 1f),
    ThreeTwo("3:2", "3:2", 3f / 2f),
    FourThree("4:3", "4:3", 4f / 3f),
    SixteenNine("16:9", "16:9", 16f / 9f),
    TwoThree("2:3", "2:3", 2f / 3f),
    ThreeFour("3:4", "3:4", 3f / 4f),
    NineSixteen("9:16", "9:16", 9f / 16f);

    fun resolveAspect(imgW: Float, imgH: Float): Float? =
        when (this) {
            Free -> null
            Original -> if (imgH > 0f) imgW / imgH else null
            else -> fixedRatio
        }
}

enum class CropHandle {
    TL,
    TR,
    BL,
    BR,
    T,
    B,
    L,
    R,
    Move,
}

object CropGeometry {
    const val MIN_CROP_FRACTION = 0.05f

    fun hitTestHandle(
        px: Float,
        py: Float,
        left: Float,
        top: Float,
        right: Float,
        bottom: Float,
        tol: Float,
    ): CropHandle? {
        val nearL = abs(px - left) <= tol
        val nearR = abs(px - right) <= tol
        val nearT = abs(py - top) <= tol
        val nearB = abs(py - bottom) <= tol
        val withinX = px in (left - tol)..(right + tol)
        val withinY = py in (top - tol)..(bottom + tol)
        return when {
            nearL && nearT -> CropHandle.TL
            nearR && nearT -> CropHandle.TR
            nearL && nearB -> CropHandle.BL
            nearR && nearB -> CropHandle.BR
            nearT && withinX -> CropHandle.T
            nearB && withinX -> CropHandle.B
            nearL && withinY -> CropHandle.L
            nearR && withinY -> CropHandle.R
            withinX && withinY -> CropHandle.Move
            else -> null
        }
    }

    fun resizeCrop(
        crop: CropRect,
        handle: CropHandle,
        nx: Float,
        ny: Float,
        lockedAspect: Float? = null,
        imgW: Float = 1f,
        imgH: Float = 1f,
    ): CropRect {
        val clampedX = nx.coerceIn(0f, 1f)
        val clampedY = ny.coerceIn(0f, 1f)
        var left = crop.left
        var right = crop.right
        var top = crop.top
        var bottom = crop.bottom

        val movesL = handle == CropHandle.TL || handle == CropHandle.BL || handle == CropHandle.L
        val movesR = handle == CropHandle.TR || handle == CropHandle.BR || handle == CropHandle.R
        val movesT = handle == CropHandle.TL || handle == CropHandle.TR || handle == CropHandle.T
        val movesB = handle == CropHandle.BL || handle == CropHandle.BR || handle == CropHandle.B

        if (movesL) left = min(clampedX, crop.right - MIN_CROP_FRACTION).coerceIn(0f, 1f)
        if (movesR) right = max(clampedX, crop.left + MIN_CROP_FRACTION).coerceIn(0f, 1f)
        if (movesT) top = min(clampedY, crop.bottom - MIN_CROP_FRACTION).coerceIn(0f, 1f)
        if (movesB) bottom = max(clampedY, crop.top + MIN_CROP_FRACTION).coerceIn(0f, 1f)

        if (lockedAspect != null && lockedAspect > 0f && imgW > 0f && imgH > 0f) {
            val ratioNorm = lockedAspect * (imgH / imgW)
            var w = right - left
            var h = bottom - top
            val corner = (movesL || movesR) && (movesT || movesB)
            val verticalMotion = abs(h - (crop.bottom - crop.top)) * imgH
            val horizontalMotion = abs(w - (crop.right - crop.left)) * imgW
            val useHeight = handle == CropHandle.T || handle == CropHandle.B ||
                (corner && verticalMotion > horizontalMotion)
            if (useHeight) {
                w = h * ratioNorm
            } else {
                h = w / ratioNorm
            }
            val anchorRight = movesL
            val anchorBottom = movesT
            left = if (anchorRight) right - w else left
            right = if (anchorRight) right else left + w
            top = if (anchorBottom) bottom - h else top
            bottom = if (anchorBottom) bottom else top + h

            val overflow =
                maxOf(
                    if (left < 0f) -left / max(w, 1e-6f) else 0f,
                    if (right > 1f) (right - 1f) / max(w, 1e-6f) else 0f,
                    if (top < 0f) -top / max(h, 1e-6f) else 0f,
                    if (bottom > 1f) (bottom - 1f) / max(h, 1e-6f) else 0f,
                )
            if (overflow > 0f) {
                val scale = 1f - overflow
                val nw = w * scale
                val nh = h * scale
                if (anchorRight) left = right - nw else right = left + nw
                if (anchorBottom) top = bottom - nh else bottom = top + nh
            }
            left = left.coerceIn(0f, 1f)
            right = right.coerceIn(0f, 1f)
            top = top.coerceIn(0f, 1f)
            bottom = bottom.coerceIn(0f, 1f)
        }
        return crop.copy(top = top, left = left, bottom = bottom, right = right)
    }

    fun moveCrop(crop: CropRect, dnx: Float, dny: Float): CropRect {
        val w = (crop.right - crop.left).coerceIn(MIN_CROP_FRACTION, 1f)
        val h = (crop.bottom - crop.top).coerceIn(MIN_CROP_FRACTION, 1f)
        val nextLeft = (crop.left + dnx).coerceIn(0f, 1f - w)
        val nextTop = (crop.top + dny).coerceIn(0f, 1f - h)
        return crop.copy(
            top = nextTop,
            left = nextLeft,
            bottom = nextTop + h,
            right = nextLeft + w,
        )
    }

    fun centeredCropForAspect(aspect: Float, imgW: Float, imgH: Float, angle: Float): CropRect {
        if (aspect <= 0f || imgW <= 0f || imgH <= 0f) {
            return CropRect(0f, 0f, 1f, 1f, angle)
        }
        val imgAspect = imgW / imgH
        val w: Float
        val h: Float
        if (aspect >= imgAspect) {
            w = 1f
            h = imgAspect / aspect
        } else {
            h = 1f
            w = aspect / imgAspect
        }
        val left = (1f - w) / 2f
        val top = (1f - h) / 2f
        return CropRect(top = top, left = left, bottom = top + h, right = left + w, angle = angle)
    }


}

fun XmpDocument.cropRect(): CropRect {
    val hasCrop = attribute("crs:HasCrop")?.equals("True", ignoreCase = true) == true
    val top = if (hasCrop) attribute("crs:CropTop")?.toFloatOrNull() ?: 0f else 0f
    val left = if (hasCrop) attribute("crs:CropLeft")?.toFloatOrNull() ?: 0f else 0f
    val bottom = if (hasCrop) attribute("crs:CropBottom")?.toFloatOrNull() ?: 1f else 1f
    val right = if (hasCrop) attribute("crs:CropRight")?.toFloatOrNull() ?: 1f else 1f
    val angle = attribute("crs:CropAngle")?.toFloatOrNull()?.coerceIn(-45f, 45f) ?: 0f
    return CropRect(
        top = top.coerceIn(0f, 1f),
        left = left.coerceIn(0f, 1f),
        bottom = bottom.coerceIn(0f, 1f),
        right = right.coerceIn(0f, 1f),
        angle = angle,
    )
}

/** Presentation only: the stored document and the undo/save path retain the real crop. */
fun XmpDocument.forCropPreview(): XmpDocument =
    mapOf("crs:HasCrop" to "True", "crs:CropTop" to "0", "crs:CropLeft" to "0",
        "crs:CropBottom" to "1", "crs:CropRight" to "1").entries.fold(this) { doc, (key, value) ->
        doc.withAttribute(key, value)
    }

internal fun MapleState.uncroppedAspect(): Float =
    values["_uncropped_aspect"]?.takeIf { it.isFinite() && it > 0f }
        ?: values["_aspect"]?.takeIf { it.isFinite() && it > 0f } ?: 1.5f

internal fun MapleState.lockedCropAspect(): Float? =
    cropAspect.resolveAspect(uncroppedAspect(), 1f)?.let {
        if (cropAspectSwapped) 1f / it else it
    }

private fun formatCropScalar(v: Float): String {
    val roundedZero = if (abs(v) < 0.0000005f) 0f else v
    return String.format(Locale.US, "%.6f", roundedZero)
}

fun MapleViewModel.applyCropRect(crop: CropRect, commit: Boolean = true) {
    val clampedAngle = crop.angle.coerceIn(-45f, 45f)
    val nonDefaultRect = !crop.isIdentityRect
    val nonDefaultAngle = abs(clampedAngle) >= 1e-4f
    val hasCrop = nonDefaultRect || nonDefaultAngle
    setAttributes(
        mapOf(
            "crs:HasCrop" to if (hasCrop) "True" else null,
            "crs:CropTop" to if (nonDefaultRect) formatCropScalar(crop.top) else null,
            "crs:CropLeft" to if (nonDefaultRect) formatCropScalar(crop.left) else null,
            "crs:CropBottom" to if (nonDefaultRect) formatCropScalar(crop.bottom) else null,
            "crs:CropRight" to if (nonDefaultRect) formatCropScalar(crop.right) else null,
            "crs:CropAngle" to if (nonDefaultAngle) formatCropScalar(clampedAngle) else null,
        ),
        commit = commit,
    )
}

@Composable
internal fun CropControlsSection(
    model: MapleViewModel,
    state: MapleState,
    modifier: Modifier = Modifier,
) {
    val crop = remember(state.document) { state.document.cropRect() }
    val imgW = state.uncroppedAspect()
    val imgH = 1f

    Column(
        modifier.fillMaxWidth().padding(vertical = 4.dp).testTag("editor-crop-toolbar"),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Row(
            Modifier.fillMaxWidth()
                .horizontalScroll(rememberScrollState())
                .testTag("editor-crop-aspect-row"),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            for (preset in CropAspectId.entries) {
                val selected = state.cropAspect == preset
                FilterChip(
                    selected = selected,
                    onClick = {
                        model.setCropAspect(preset)
                        val resolved = preset.resolveAspect(imgW, imgH)
                        if (resolved != null) {
                            model.applyCropRect(
                                CropGeometry.centeredCropForAspect(
                                    resolved,
                                    imgW,
                                    imgH,
                                    crop.angle,
                                )
                            )
                        }
                    },
                    enabled = state.canEdit,
                    label = { Text(preset.label, fontSize = 11.sp) },
                    modifier =
                        Modifier.semantics { contentDescription = "Aspect ${preset.label}" }
                            .testTag("editor-crop-aspect-${preset.rawId}"),
                )
            }
        }
        TextButton(
            onClick = {
                val aspect = state.lockedCropAspect() ?: return@TextButton
                model.setCropAspect(state.cropAspect, !state.cropAspectSwapped)
                model.applyCropRect(CropGeometry.centeredCropForAspect(1f / aspect, imgW, imgH, crop.angle))
            },
            enabled = state.canEdit && state.lockedCropAspect() != null,
            modifier = Modifier.testTag("crop-swap-aspect-button"),
        ) { Text("Swap aspect orientation", fontSize = 11.sp) }
        Column(Modifier.fillMaxWidth()) {
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("Straighten", fontSize = 12.sp, color = MapleColors.text)
                Text(
                    String.format(Locale.US, "%+.1f°", crop.angle),
                    fontSize = 11.sp,
                    color = MapleColors.muted,
                    fontFamily = FontFamily.Monospace,
                )
            }
            Slider(
                value = crop.angle,
                onValueChange = { nextAngle ->
                    model.applyCropRect(
                        crop.copy(angle = nextAngle.coerceIn(-45f, 45f)),
                        commit = false,
                    )
                },
                onValueChangeFinished = model::commitGesture,
                valueRange = -45f..45f,
                enabled = state.canEdit,
                modifier =
                    Modifier.fillMaxWidth()
                        .semantics { contentDescription = "Straighten angle" }
                        .testTag("crop-straighten-slider"),
            )
        }
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            // Image rotation and mirroring remain tracked by #5191.
            // Moving crop bounds alone does not transform image pixels.
            TextButton(
                onClick = {
                    model.setCropAspect(CropAspectId.Free)
                    model.applyCropRect(CropRect())
                },
                enabled = state.canEdit && !crop.isIdentity,
                modifier = Modifier.testTag("crop-reset-button"),
            ) {
                Text("Reset Crop", fontSize = 11.sp)
            }
        }
    }
}

@Composable
internal fun CropOverlay(
    crop: CropRect,
    onCropChange: (CropRect) -> Unit,
    onCropCommit: () -> Unit = {},
    modifier: Modifier = Modifier,
    lockedAspect: Float? = null,
    imageAspect: Float = 1f,
) {
    val currentAspect by rememberUpdatedState(lockedAspect)
    val currentImageAspect by rememberUpdatedState(imageAspect)
    val currentCrop by rememberUpdatedState(crop)
    val currentCallback by rememberUpdatedState(onCropChange)
    val currentCommit by rememberUpdatedState(onCropCommit)
    Canvas(
        modifier
            .fillMaxSize()
            .pointerInput(Unit) {
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    val w = size.width.toFloat().coerceAtLeast(1f)
                    val h = size.height.toFloat().coerceAtLeast(1f)
                    val startCrop = currentCrop
                    val handle =
                        CropGeometry.hitTestHandle(
                            px = down.position.x,
                            py = down.position.y,
                            left = startCrop.left * w,
                            top = startCrop.top * h,
                            right = startCrop.right * w,
                            bottom = startCrop.bottom * h,
                            tol = 36f,
                        ) ?: return@awaitEachGesture
                    var workingCrop = startCrop
                    var lastPos = down.position
                    var moved = false
                    try {
                        do {
                            val event = awaitPointerEvent()
                            if (event.changes.count { it.pressed } > 1) break
                            val change = event.changes.firstOrNull { it.pressed } ?: break
                            if (change.positionChanged()) {
                                val pos = change.position
                                val updated =
                                    if (handle == CropHandle.Move) {
                                        CropGeometry.moveCrop(
                                            workingCrop,
                                            (pos.x - lastPos.x) / w,
                                            (pos.y - lastPos.y) / h,
                                        )
                                    } else {
                                        CropGeometry.resizeCrop(
                                            workingCrop,
                                            handle,
                                            pos.x / w,
                                            pos.y / h,
                                            lockedAspect = currentAspect,
                                            imgW = currentImageAspect,
                                            imgH = 1f,
                                        )
                                    }
                                workingCrop = updated
                                lastPos = pos
                                moved = true
                                currentCallback(updated)
                                change.consume()
                            }
                        } while (event.changes.any { it.pressed })
                    } finally {
                        if (moved) currentCommit()
                    }
                }
            }
            .testTag("crop-overlay")
    ) {
        val leftPx = crop.left * size.width
        val topPx = crop.top * size.height
        val cropW = (crop.right - crop.left) * size.width
        val cropH = (crop.bottom - crop.top) * size.height

        drawRect(
            color = Color.White,
            topLeft = Offset(leftPx, topPx),
            size = Size(cropW, cropH),
            style = Stroke(width = 2.dp.toPx()),
        )
        // Rule-of-thirds grid lines
        for (i in 1..2) {
            val x = leftPx + cropW * (i / 3f)
            val y = topPx + cropH * (i / 3f)
            drawLine(
                color = Color.White.copy(alpha = 0.45f),
                start = Offset(x, topPx),
                end = Offset(x, topPx + cropH),
                strokeWidth = 1.dp.toPx(),
            )
            drawLine(
                color = Color.White.copy(alpha = 0.45f),
                start = Offset(leftPx, y),
                end = Offset(leftPx + cropW, y),
                strokeWidth = 1.dp.toPx(),
            )
        }
    }
}
