package app.justmaple.aperture.ui

import androidx.compose.ui.geometry.Offset
import org.junit.Assert.assertEquals
import org.junit.Test

class PinchTrackerTest {
    @Test
    fun heldFingersDriveMagnificationAndFocalPoint() {
        val pinch = PinchTracker(listOf(Offset(300f, 400f), Offset(700f, 400f)))
        assertEquals(Offset(500f, 400f), pinch.centroid)
        pinch.advance(listOf(Offset(300f, 400f), Offset(700f, 400f)), listOf(Offset(200f, 420f), Offset(800f, 420f)))
        assertEquals(1.5f, pinch.magnification, 1e-6f)
        assertEquals(Offset(500f, 420f), pinch.centroid)
    }

    @Test
    fun aFingerLandingOrLiftingMidPinchChangesNeitherZoomNorFocalPoint() {
        val pinch = PinchTracker(listOf(Offset(300f, 400f), Offset(700f, 400f)))
        pinch.advance(listOf(Offset(300f, 400f), Offset(700f, 400f)), listOf(Offset(300f, 400f), Offset(700f, 400f)))
        // A third finger lands at 800: only the two held fingers are compared, and they did not move.
        pinch.advance(listOf(Offset(300f, 400f), Offset(700f, 400f)), listOf(Offset(300f, 400f), Offset(700f, 400f)))
        assertEquals(1f, pinch.magnification, 0f)
        assertEquals(Offset(500f, 400f), pinch.centroid)
        // With three held fingers, movement still drives the pinch.
        val three = listOf(Offset(300f, 400f), Offset(700f, 400f), Offset(800f, 400f))
        pinch.advance(three, three.map { it + Offset(10f, 0f) })
        assertEquals(Offset(510f, 400f), pinch.centroid)
        // The first finger lifts: the two still held did not move, so nothing changes.
        val remaining = listOf(Offset(710f, 400f), Offset(810f, 400f))
        pinch.advance(remaining, remaining)
        assertEquals(1f, pinch.magnification, 1e-6f)
        assertEquals(Offset(510f, 400f), pinch.centroid)
    }

    @Test
    fun fewerThanTwoHeldFingersAreIgnoredAndACollapsedSpanKeepsTheZoom() {
        val pinch = PinchTracker(listOf(Offset(0f, 0f), Offset(100f, 0f)))
        pinch.advance(listOf(Offset(0f, 0f)), listOf(Offset(50f, 0f)))
        pinch.advance(listOf(Offset(10f, 10f), Offset(10f, 10f)), listOf(Offset(0f, 0f), Offset(40f, 0f)))
        assertEquals(1f, pinch.magnification, 0f)
        assertEquals(Offset(60f, -10f), pinch.centroid)
    }
}
