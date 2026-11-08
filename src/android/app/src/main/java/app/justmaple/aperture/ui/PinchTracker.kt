package app.justmaple.aperture.ui

import androidx.compose.ui.geometry.Offset

/** One pointer across an event: where it was (null if it just landed) and is (null if it lifted). */
internal data class PinchFinger(val previous: Offset?, val current: Offset?)

/**
 * A pinch's cumulative magnification and focal point for the shared zoom model (#5714). The
 * magnification advances only by the span of fingers held down across an event, so a finger
 * landing or lifting is never read as a zoom; the focal point is always the true centroid of the
 * fingers pressed now, and [advance] reports when the set changed so the caller rebases the pinch
 * about the new set before the next frame.
 */
internal class PinchTracker(start: List<Offset>) {
    var magnification = 1f
        private set
    var centroid = mean(start)
        private set

    /**
     * Advances by one event's [fingers]. Returns null when the same fingers stayed down; otherwise
     * the point to rebase the pinch on: the new set's centroid before this event's movement.
     */
    fun advance(fingers: List<PinchFinger>): Offset? {
        val held = fingers.mapNotNull { finger -> finger.previous?.let { from -> finger.current?.let { from to it } } }
        if (held.size >= 2) {
            val before = held.map { it.first }
            val after = held.map { it.second }
            val previousSpan = span(before, mean(before))
            val currentSpan = span(after, mean(after))
            if (previousSpan > 0f && currentSpan > 0f) magnification *= currentSpan / previousSpan
        }
        val pressed = fingers.mapNotNull { it.current }
        if (pressed.isEmpty()) return null
        centroid = mean(pressed)
        val regrouped = fingers.any { (it.previous == null) != (it.current == null) }
        return if (regrouped) mean(fingers.mapNotNull { finger -> finger.current?.let { finger.previous ?: it } }) else null
    }

    private companion object {
        fun mean(points: List<Offset>): Offset =
            Offset(
                points.sumOf { it.x.toDouble() }.toFloat() / points.size,
                points.sumOf { it.y.toDouble() }.toFloat() / points.size,
            )

        fun span(points: List<Offset>, centroid: Offset): Float =
            points.sumOf { (it - centroid).getDistance().toDouble() }.toFloat() / points.size
    }
}
