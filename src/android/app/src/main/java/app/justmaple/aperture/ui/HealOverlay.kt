package app.justmaple.aperture.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.gestures.awaitEachGesture
import androidx.compose.foundation.gestures.awaitFirstDown
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import app.justmaple.aperture.MapleState
import app.justmaple.aperture.MapleViewModel
import app.justmaple.aperture.data.MaskPoint
import app.justmaple.aperture.data.RepairSpot
import app.justmaple.aperture.placeRepair
import app.justmaple.aperture.repairSpots
import app.justmaple.aperture.selectRepair
import app.justmaple.aperture.setRepairSpot
import kotlin.math.max
import kotlin.math.roundToInt

private val GRAB_RADIUS = 14.dp

internal fun repairSpotName(spot: RepairSpot, index: Int) = "${spot.kind.label} ${index + 1}"

internal fun healOverlayValue(count: Int): String =
    when (count) {
        0 -> "No repair spots"
        1 -> "1 repair spot"
        else -> "$count repair spots"
    }

/**
 * The repair spots over the canvas (`docs/features.md` § Clone / heal brush): every
 * destination disc, and the selected spot's source disc joined to it by a line. It fills the
 * presented image box like [MaskOverlay], so canvas zoom reaches it through the parent's
 * graphics layer, and points cross the same crop and manual-geometry map onto the full frame
 * spots live in (repairs, like masks, run ahead of the Geometry warp); each disc is drawn
 * and hit-tested as its boundary projected through that map, so a stretch or keystone
 * shows the footprint that actually renders, not a screen circle;
 * [zoom] counter-scales the strokes and grab radius. A press on a spot selects it and drags
 * its handle; a press on empty canvas places a spot with the brush once it is released or
 * moves past the touch slop, and that drag then aims the new spot's source. A second finger
 * before then leaves the gesture to canvas zoom.
 */
@Composable
internal fun HealOverlay(model: MapleViewModel, state: MapleState, zoom: Float, modifier: Modifier = Modifier) {
    val spots = remember(state.document) { runCatching { model.repairSpots(state.document) }.getOrDefault(emptyList()) }
    val (toFrame, fromFrame) = rememberFrameMaps(model, state)
    val scale = zoom.coerceAtLeast(.01f)
    val grab = with(LocalDensity.current) { GRAB_RADIUS.toPx() } / scale
    val currentSpots by rememberUpdatedState(spots)
    val currentSelection by rememberUpdatedState(state.healSelection)
    val currentToFrame by rememberUpdatedState(toFrame)
    val currentFromFrame by rememberUpdatedState(fromFrame)
    val currentGrab by rememberUpdatedState(grab)
    val currentAspect by rememberUpdatedState(state.uncroppedAspect())
    BoxWithConstraints(
        modifier
            .fillMaxSize()
            .testTag("editor-heal-overlay")
            .semantics {
                contentDescription = "Heal overlay"
                stateDescription = healOverlayValue(spots.size)
            }
            .pointerInput(model) {
                awaitEachGesture {
                    val down = awaitFirstDown(requireUnconsumed = false)
                    val w = size.width.toFloat().coerceAtLeast(1f)
                    val h = size.height.toFloat().coerceAtLeast(1f)
                    val forward = currentToFrame ?: return@awaitEachGesture
                    val back = currentFromFrame ?: return@awaitEachGesture
                    fun frameAt(position: Offset) = forward.apply(MaskPoint(position.x / w, position.y / h))
                    fun screen(point: MaskPoint) = back.apply(point).let { MaskPoint(it.x * w, it.y * h) }
                    val spots = currentSpots
                    val hit =
                        hitRepair(spots, currentSelection, MaskPoint(down.position.x, down.position.y), currentGrab,
                            ::screen) { center, spot ->
                            repairFootprint(center, spot.radius, currentAspect) { screen(it) }
                        }
                    var start: RepairSpot? = null
                    var handle = RepairHandle.Source
                    var anchor = frameAt(down.position)
                    if (hit != null) {
                        down.consume()
                        model.selectRepair(hit.first)
                        start = spots[hit.first]
                        handle = hit.second
                    }
                    var moved = false
                    try {
                        while (true) {
                            val event = awaitPointerEvent()
                            if (start == null && event.changes.count { it.pressed } > 1) return@awaitEachGesture
                            val change = event.changes.firstOrNull { it.id == down.id } ?: break
                            val travel = (change.position - down.position).getDistance()
                            if (start == null && (!change.pressed || travel > viewConfiguration.touchSlop)) {
                                change.consume()
                                start = model.placeRepair(anchor) ?: break
                                anchor = start.source
                            }
                            if (!change.pressed) break
                            val spot = start ?: continue
                            if (change.positionChanged()) {
                                change.consume()
                                moved = true
                                model.setRepairSpot(dragRepair(spot, handle, frameAt(change.position), anchor))
                            }
                        }
                    } finally {
                        if (moved) model.commitGesture()
                    }
                }
            }
    ) {
        fromFrame?.let { back ->
            HealMarks(spots, state.healSelection?.takeIf { it in spots.indices }, back, scale,
                constraints.maxWidth.toFloat(), constraints.maxHeight.toFloat(), state.uncroppedAspect())
        }
    }
}

/** The discs, the selected spot's source link, and one labelled handle per grabbable point. */
@Composable
private fun HealMarks(
    spots: List<RepairSpot>,
    selected: Int?,
    back: MaskProjection,
    scale: Float,
    w: Float,
    h: Float,
    aspect: Float,
) {
    fun px(point: MaskPoint) = back.apply(point).let { Offset(it.x * w, it.y * h) }
    fun footprintPath(center: MaskPoint, spot: RepairSpot): Path {
        val points = repairFootprint(center, spot.radius, aspect) { back.apply(it).let { p -> MaskPoint(p.x * w, p.y * h) } }
        return Path().apply {
            points.firstOrNull()?.let { moveTo(it.x, it.y) }
            points.drop(1).forEach { lineTo(it.x, it.y) }
            close()
        }
    }
    // Decorative: the discs and link carry no semantics; the handles below do.
    Canvas(Modifier.fillMaxSize()) {
        val stroke = 1.5.dp.toPx() / scale
        val outline = Stroke(max(1f, stroke * 2.5f))
        spots.forEachIndexed { index, spot ->
            val color = if (index == selected) MapleColors.primary else Color.White.copy(alpha = .9f)
            drawPath(footprintPath(spot.center, spot), Color.Black.copy(alpha = .45f), style = outline)
            drawPath(footprintPath(spot.center, spot), color, style = Stroke(stroke))
        }
        selected?.let { spots[it] }?.let { spot ->
            val dash = PathEffect.dashPathEffect(floatArrayOf(6.dp.toPx() / scale, 4.dp.toPx() / scale))
            drawLine(Color.White.copy(alpha = .9f), px(spot.center), px(spot.source), stroke, pathEffect = dash)
            drawPath(footprintPath(spot.source, spot), Color.Black.copy(alpha = .45f), style = outline)
            drawPath(footprintPath(spot.source, spot), Color.White.copy(alpha = .9f),
                style = Stroke(stroke, pathEffect = dash))
        }
    }
    spots.forEachIndexed { index, spot ->
        HealHandle(px(spot.center), scale, "editor-heal-spot-$index",
            "Repair spot ${repairSpotName(spot, index)}: destination", index == selected)
    }
    selected?.let { index ->
        HealHandle(px(spots[index].source), scale, "editor-heal-source",
            "Repair spot ${repairSpotName(spots[index], index)}: source", true)
    }
}

@Composable
private fun HealHandle(at: Offset, scale: Float, tag: String, label: String, active: Boolean) {
    val box = GRAB_RADIUS * 2 / scale
    Box(
        Modifier.offset { IntOffset((at.x - box.toPx() / 2).roundToInt(), (at.y - box.toPx() / 2).roundToInt()) }
            .size(box)
            .testTag(tag)
            .semantics {
                contentDescription = label
                selected = active
            }
    )
}

