package app.justmaple.aperture.ui

import androidx.compose.ui.geometry.Offset

/**
 * A pinch's cumulative magnification and focal point for the shared zoom model (#5714). Both
 * advance only by the movement of fingers held down across an event, so a finger landing or
 * lifting mid-pinch changes neither and is never read as a zoom or a pan.
 */
internal class PinchTracker(start: List<Offset>) {
    var magnification = 1f
        private set
    var centroid = mean(start)
        private set

    /** Advances by the held fingers' `previous` → `current` positions, in matching order. */
    fun advance(previous: List<Offset>, current: List<Offset>) {
        if (previous.size < 2 || previous.size != current.size) return
        val previousCentroid = mean(previous)
        val currentCentroid = mean(current)
        val previousSpan = span(previous, previousCentroid)
        val currentSpan = span(current, currentCentroid)
        if (previousSpan > 0f && currentSpan > 0f) magnification *= currentSpan / previousSpan
        centroid += currentCentroid - previousCentroid
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
