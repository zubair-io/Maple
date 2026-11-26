package app.justmaple.aperture.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.gestures.drag
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import app.justmaple.aperture.cloud.*

/** The frame and mode new seam regions take, shared by the drag overlay and the numeric form. */
@Stable
internal class SeamBrush {
    var frame by mutableIntStateOf(0)
    var kind by mutableStateOf(PanoSeamKind.Include)
    var error by mutableStateOf<String?>(null)
}

private fun PanoSeamKind.color() = if (this == PanoSeamKind.Include) MapleColors.primary else MapleColors.error

private fun seamRegions(count: Int) = if (count == 1) "1 seam region" else "$count seam regions"

/** The preview box keeps the canvas's aspect ratio, so its pixels map linearly onto canvas pixels. */
@Composable
internal fun BoxScope.SeamOverlay(state: PanoramaState, session: PanoramaSession, brush: SeamBrush) {
    val (canvasWidth, canvasHeight) = state.seamCanvas ?: return
    val enabled = state.seamBlocked == null
    var dragged by remember { mutableStateOf<Pair<Offset, Offset>?>(null) }
    val regions = state.seams?.regions.orEmpty()
    val described = "Seam canvas, ${seamRegions(regions.size)}. " +
        if (enabled) "Drag to add a ${brush.kind.label} region for frame ${brush.frame + 1}." else state.seamBlocked
    Canvas(
        Modifier.matchParentSize().testTag("pano-seam-canvas")
            .semantics { contentDescription = described }
            .pointerInput(enabled, canvasWidth, canvasHeight) {
                if (!enabled) return@pointerInput
                fun canvasPoint(at: Offset) =
                    Offset(
                        (at.x / size.width * canvasWidth).coerceIn(0f, canvasWidth.toFloat()),
                        (at.y / size.height * canvasHeight).coerceIn(0f, canvasHeight.toFloat()),
                    )
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    val start = canvasPoint(down.position)
                    try {
                        val released = drag(down.id) { change ->
                            // A tap that jitters stays a tap: the region begins once the finger has left the slop.
                            if (dragged != null || (change.position - down.position).getDistance() > viewConfiguration.touchSlop)
                                dragged = start to canvasPoint(change.position)
                            change.consume()
                        }
                        val end = dragged?.second
                        if (released && end != null)
                            PanoSeamConstraints.dragRegion(
                                start.x, start.y, end.x, end.y, canvasWidth, canvasHeight, brush.kind, brush.frame,
                            )?.let { brush.error = session.addSeam(it) }
                    } finally {
                        dragged = null
                    }
                }
            },
    ) {
        val scaleX = size.width / canvasWidth
        val scaleY = size.height / canvasHeight
        fun outline(kind: PanoSeamKind, left: Float, top: Float, right: Float, bottom: Float) =
            drawRect(kind.color(), Offset(left * scaleX, top * scaleY),
                Size((right - left) * scaleX, (bottom - top) * scaleY), style = Stroke(2.dp.toPx()))
        regions.forEach {
            outline(it.kind, it.x.toFloat(), it.y.toFloat(), (it.x + it.width).toFloat(), (it.y + it.height).toFloat())
        }
        dragged?.let { (start, end) ->
            outline(brush.kind, minOf(start.x, end.x), minOf(start.y, end.y), maxOf(start.x, end.x), maxOf(start.y, end.y))
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun SeamEditor(state: PanoramaState, session: PanoramaSession, brush: SeamBrush) {
    val image = state.image ?: return
    val blocked = state.seamBlocked
    val enabled = blocked == null
    Text("Seam regions", style = MaterialTheme.typography.titleSmall)
    Text("Include keeps a frame's pixels in a region; Exclude keeps them out. Drag on the preview " +
        "or enter preview pixels.", color = MapleColors.muted)
    blocked?.let { Text(it, color = MapleColors.muted, modifier = Modifier.testTag("pano-seam-blocked")) }
    Text("Source frame")
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        image.frames.forEachIndexed { index, frame ->
            FilterChip(selected = brush.frame == index, onClick = { brush.frame = index }, enabled = enabled,
                label = { Text("${index + 1}. ${frame.name}") },
                modifier = Modifier.testTag("pano-seam-frame-$index")
                    .semantics { contentDescription = "Frame: ${index + 1}. ${frame.name}" })
        }
    }
    Text("Region mode")
    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        PanoSeamKind.entries.forEach { kind ->
            FilterChip(selected = brush.kind == kind, onClick = { brush.kind = kind }, enabled = enabled,
                label = { Text(kind.label) },
                modifier = Modifier.testTag("pano-seam-mode-${kind.label}")
                    .semantics { contentDescription = "Mode: ${kind.label}" })
        }
    }
    CoordinateForm(session, brush, enabled)
    brush.error?.let {
        Text(it, color = MapleColors.error,
            modifier = Modifier.testTag("pano-seam-error").semantics { liveRegion = LiveRegionMode.Polite })
    }
    val regions = state.seams?.regions.orEmpty()
    regions.forEachIndexed { index, region ->
        Row(Modifier.fillMaxWidth().testTag("pano-seam-region-$index").semantics(mergeDescendants = true) {},
            verticalAlignment = Alignment.CenterVertically) {
            Text("${index + 1}. ${region.kind.label} frame ${region.frame + 1} · " +
                "${region.x}, ${region.y} · ${region.width} × ${region.height} px",
                color = region.kind.color(), modifier = Modifier.weight(1f))
            TextButton(onClick = { session.removeSeam(index) }, enabled = !state.stitching,
                modifier = Modifier.testTag("pano-seam-remove-$index")
                    .semantics { contentDescription = "Remove seam region ${index + 1}" }) { Text("Remove") }
        }
    }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        TextButton(onClick = session::clearSeams, enabled = regions.isNotEmpty() && !state.stitching,
            modifier = Modifier.testTag("pano-seam-clear")) { Text("Clear regions") }
        OutlinedButton(onClick = session::previewSeams, enabled = enabled,
            modifier = Modifier.testTag("pano-seam-preview")) { Text("Preview regions") }
    }
    image.seams?.let {
        Text("This preview was made with ${seamRegions(it.regions.size)}.", color = MapleColors.muted,
            modifier = Modifier.testTag("pano-seam-previewed"))
    }
}

/** Whole preview pixels typed or pasted, so the form never depends on an IME action key. */
@Composable
private fun CoordinateForm(session: PanoramaSession, brush: SeamBrush, enabled: Boolean) {
    val fields = listOf("X", "Y", "Width", "Height")
    val values = fields.map { field -> rememberSaveable(field) { mutableStateOf("") } }
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        fields.forEachIndexed { index, field ->
            OutlinedTextField(
                value = values[index].value,
                onValueChange = { typed -> if (typed.all(Char::isDigit)) values[index].value = typed.take(10) },
                label = { Text(field) },
                singleLine = true,
                enabled = enabled,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                modifier = Modifier.weight(1f).testTag("pano-seam-${field.lowercase()}")
                    .semantics { stateDescription = "Seam region $field in preview pixels" },
            )
        }
    }
    Button(
        onClick = {
            val numbers = values.map { it.value.toIntOrNull() }
            brush.error =
                if (numbers.any { it == null }) "Enter X, Y, width and height in preview pixels."
                else session.addSeam(PanoSeamRegion(brush.kind, brush.frame, numbers[0]!!, numbers[1]!!, numbers[2]!!, numbers[3]!!))
            if (brush.error == null) values.forEach { it.value = "" }
        },
        enabled = enabled,
        modifier = Modifier.testTag("pano-seam-add"),
    ) { Text("Add region") }
}
