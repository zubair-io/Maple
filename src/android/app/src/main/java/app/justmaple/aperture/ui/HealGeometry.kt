package app.justmaple.aperture.ui

import app.justmaple.aperture.data.MaskPoint
import app.justmaple.aperture.data.RepairSpot
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.sin

/** A spot's two draggable points (Apple's `RetouchHandle`). */
enum class RepairHandle(val id: String, val label: String) { Destination("destination", "destination"), Source("source", "source") }

/**
 * Where a new spot samples from: one and a half radii to the right of [center], mirrored
 * left when that would leave the frame. [radius] is a fraction of the frame width, the unit
 * x is normalised in, so the offset is exact across the frame (Apple's `defaultSource`).
 */
fun defaultRepairSource(center: MaskPoint, radius: Float): MaskPoint {
    val offset = radius * 1.5f
    val x = if (center.x + offset <= 1f) center.x + offset else center.x - offset
    return MaskPoint(x.coerceIn(0f, 1f), center.y)
}

/**
 * [start] with [handle] dragged to [point]; [anchor] is where the drag began. Dragging the
 * destination carries the source with it, so the offset the user chose survives a
 * reposition; dragging the source moves it alone.
 */
fun dragRepair(start: RepairSpot, handle: RepairHandle, point: MaskPoint, anchor: MaskPoint): RepairSpot {
    if (!point.x.isFinite() || !point.y.isFinite()) return start
    val (dx, dy) = point.x - anchor.x to point.y - anchor.y
    fun moved(p: MaskPoint) = MaskPoint((p.x + dx).coerceIn(0f, 1f), (p.y + dy).coerceIn(0f, 1f))
    return when (handle) {
        RepairHandle.Source -> start.copy(source = moved(start.source))
        RepairHandle.Destination -> start.copy(center = moved(start.center), source = moved(start.source))
    }
}

/** Boundary samples of a repair footprint; enough that a keystone's curve reads smooth. */
const val REPAIR_FOOTPRINT_STEPS = 64

/**
 * The screen footprint of the frame-space disc at [center]: the circle in frame pixels
 * ([radius] is a fraction of the frame width, so its normalised y radius is
 * `radius * aspect` for the frame's width/height [aspect]) with every boundary point
 * carried through [project] (frame → screen pixels). Under a non-uniform stretch or
 * keystone this is not a screen circle, which is exactly what renders.
 */
fun repairFootprint(
    center: MaskPoint,
    radius: Float,
    aspect: Float,
    project: (MaskPoint) -> MaskPoint,
): List<MaskPoint> {
    val ratio = aspect.takeIf { it.isFinite() && it > 0f } ?: 1f
    return (0 until REPAIR_FOOTPRINT_STEPS).map { step ->
        val angle = (step.toDouble() / REPAIR_FOOTPRINT_STEPS) * 2.0 * Math.PI
        project(
            MaskPoint(
                center.x + (radius * cos(angle)).toFloat(),
                center.y + (radius * ratio * sin(angle)).toFloat(),
            )
        )
    }
}

/** Whether screen point [at] lies inside the closed projected [footprint] polygon. */
fun repairFootprintContains(at: MaskPoint, footprint: List<MaskPoint>): Boolean {
    if (footprint.size < 3 || !at.x.isFinite() || !at.y.isFinite()) return false
    var inside = false
    var previous = footprint.last()
    for (point in footprint) {
        if (!point.x.isFinite() || !point.y.isFinite() || !previous.x.isFinite() || !previous.y.isFinite()) return false
        if ((point.y > at.y) != (previous.y > at.y)) {
            val crossingX = point.x + (at.y - point.y) * (previous.x - point.x) / (previous.y - point.y)
            if (at.x < crossingX) inside = !inside
        }
        previous = point
    }
    return inside
}

/**
 * The spot and handle under the screen point [at], or `null`. [toScreen] places a full-frame
 * point on screen and [footprint] projects a disc at a frame centre onto the screen; a press
 * within [grab] of a handle centre, or inside that disc's projected footprint, hits. The
 * selected spot is tested first, by its nearer handle (the source on a tie, as it draws on
 * top), then by footprint (the source first, as it draws on top); the others back to front
 * by destination, so the spot placed last is grabbed.
 */
fun hitRepair(
    spots: List<RepairSpot>,
    selected: Int?,
    at: MaskPoint,
    grab: Float,
    toScreen: (MaskPoint) -> MaskPoint,
    footprint: (MaskPoint, RepairSpot) -> List<MaskPoint>,
): Pair<Int, RepairHandle>? {
    fun distance(point: MaskPoint) = toScreen(point).let { hypot(it.x - at.x, it.y - at.y) }
    selected?.let { index ->
        val spot = spots.getOrNull(index) ?: return@let
        val (source, destination) = distance(spot.source) to distance(spot.center)
        if (minOf(source, destination) <= grab) {
            return index to if (source <= destination) RepairHandle.Source else RepairHandle.Destination
        }
        if (repairFootprintContains(at, footprint(spot.source, spot))) return index to RepairHandle.Source
        if (repairFootprintContains(at, footprint(spot.center, spot))) return index to RepairHandle.Destination
    }
    return spots.indices.reversed().firstOrNull {
        it != selected &&
            (distance(spots[it].center) <= grab || repairFootprintContains(at, footprint(spots[it].center, spots[it])))
    }?.let { it to RepairHandle.Destination }
}
