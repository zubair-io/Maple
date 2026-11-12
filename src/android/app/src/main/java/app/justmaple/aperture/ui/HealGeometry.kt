package app.justmaple.aperture.ui

import app.justmaple.aperture.data.MaskPoint
import app.justmaple.aperture.data.RepairSpot
import kotlin.math.hypot

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

/**
 * The spot and handle under the screen point [at], or `null`. [toScreen] places a full-frame
 * point on screen and [radiusOnScreen] a spot's disc radius; a press within [grab] or the disc
 * hits. The selected spot is tested first, by its nearer handle (the source on a tie, as it
 * draws on top); the others back to front by destination, so the spot placed last is grabbed.
 */
fun hitRepair(
    spots: List<RepairSpot>,
    selected: Int?,
    at: MaskPoint,
    grab: Float,
    toScreen: (MaskPoint) -> MaskPoint,
    radiusOnScreen: (RepairSpot) -> Float,
): Pair<Int, RepairHandle>? {
    fun distance(point: MaskPoint) = toScreen(point).let { hypot(it.x - at.x, it.y - at.y) }
    fun reach(spot: RepairSpot) = maxOf(grab, radiusOnScreen(spot))
    selected?.let { index ->
        val spot = spots.getOrNull(index) ?: return@let
        val (source, destination) = distance(spot.source) to distance(spot.center)
        val handle = if (source <= destination) RepairHandle.Source else RepairHandle.Destination
        if (minOf(source, destination) <= reach(spot)) return index to handle
    }
    return spots.indices.reversed().firstOrNull { it != selected && distance(spots[it].center) <= reach(spots[it]) }
        ?.let { it to RepairHandle.Destination }
}
