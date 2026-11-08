package app.justmaple.aperture.ui

import androidx.compose.ui.geometry.Offset
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class PinchTrackerTest {
    private fun held(from: Offset, to: Offset) = PinchFinger(from, to)

    private fun still(at: Offset) = PinchFinger(at, at)

    @Test
    fun heldFingersDriveMagnificationAndFocalPoint() {
        val pinch = PinchTracker(listOf(Offset(300f, 400f), Offset(700f, 400f)))
        assertEquals(Offset(500f, 400f), pinch.centroid)
        val rebase =
            pinch.advance(
                listOf(held(Offset(300f, 400f), Offset(200f, 420f)), held(Offset(700f, 400f), Offset(800f, 420f))),
            )
        assertNull(rebase)
        assertEquals(1.5f, pinch.magnification, 1e-6f)
        assertEquals(Offset(500f, 420f), pinch.centroid)
    }

    @Test
    fun aFingerLandingKeepsTheZoomAndMovesTheFocalPointToTheTrueCentroid() {
        val pinch = PinchTracker(listOf(Offset(300f, 400f), Offset(700f, 400f)))
        val rebase =
            pinch.advance(
                listOf(still(Offset(300f, 400f)), still(Offset(700f, 400f)), PinchFinger(null, Offset(800f, 400f))),
            )
        assertEquals(Offset(600f, 400f), rebase)
        assertEquals(1f, pinch.magnification, 0f)
        assertEquals(Offset(600f, 400f), pinch.centroid)
    }

    /** Codex on #5722: after a third finger lands, spreading all three 2× pivots on their centroid. */
    @Test
    fun threeFingersSpreadingScaleAboutTheirOwnCentroid() {
        val pinch = PinchTracker(listOf(Offset(300f, 400f), Offset(700f, 400f)))
        pinch.advance(listOf(still(Offset(300f, 400f)), still(Offset(700f, 400f)), PinchFinger(null, Offset(800f, 400f))))
        val rebase =
            pinch.advance(
                listOf(
                    held(Offset(300f, 400f), Offset(0f, 400f)),
                    held(Offset(700f, 400f), Offset(800f, 400f)),
                    held(Offset(800f, 400f), Offset(1000f, 400f)),
                ),
            )
        assertNull(rebase)
        assertEquals(2f, pinch.magnification, 1e-6f)
        assertEquals(Offset(600f, 400f), pinch.centroid)
    }

    @Test
    fun aFingerLiftingRebasesOnTheRemainingFingersBeforeTheirMovement() {
        val pinch = PinchTracker(listOf(Offset(300f, 400f), Offset(700f, 400f), Offset(800f, 400f)))
        val rebase =
            pinch.advance(
                listOf(
                    PinchFinger(Offset(300f, 400f), null),
                    held(Offset(700f, 400f), Offset(710f, 400f)),
                    held(Offset(800f, 400f), Offset(810f, 400f)),
                ),
            )
        assertEquals(Offset(750f, 400f), rebase)
        assertEquals(1f, pinch.magnification, 1e-6f)
        assertEquals(Offset(760f, 400f), pinch.centroid)
    }

    @Test
    fun fewerThanTwoHeldFingersAndACollapsedSpanKeepTheZoom() {
        val pinch = PinchTracker(listOf(Offset(0f, 0f), Offset(100f, 0f)))
        pinch.advance(listOf(held(Offset(0f, 0f), Offset(50f, 0f)), PinchFinger(null, Offset(70f, 0f))))
        assertEquals(1f, pinch.magnification, 0f)
        pinch.advance(listOf(held(Offset(10f, 10f), Offset(0f, 0f)), held(Offset(10f, 10f), Offset(40f, 0f))))
        assertEquals(1f, pinch.magnification, 0f)
        assertEquals(Offset(20f, 0f), pinch.centroid)
    }
}
