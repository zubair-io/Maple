package app.justmaple.aperture.ui

import app.justmaple.aperture.data.MaskPoint
import app.justmaple.aperture.data.RepairKind
import app.justmaple.aperture.data.RepairSpot
import kotlin.math.cos
import kotlin.math.sin
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The drawn repair footprint is the frame-space disc's boundary carried through the same
 * frame map the mask overlay uses, not a screen circle built from the horizontal radius:
 * under a non-uniform stretch or a keystone the projected points are the footprint, and
 * hit testing follows them (destination and, for the selected spot, source alike).
 */
class HealFootprintTest {
    private val aspect = 1.5f
    private val spot =
        RepairSpot(RepairKind.Heal, MaskPoint(.5f, .5f), MaskPoint(.7f, .5f), .1f, .5f, 1f)

    private fun screen(back: MaskProjection, w: Float = 300f, h: Float = 200f): (MaskPoint) -> MaskPoint =
        { back.apply(it).let { p -> MaskPoint(p.x * w, p.y * h) } }

    private fun expected(back: MaskProjection, center: MaskPoint): List<MaskPoint> =
        (0 until REPAIR_FOOTPRINT_STEPS).map { step ->
            val angle = step.toDouble() / REPAIR_FOOTPRINT_STEPS * 2.0 * Math.PI
            screen(back)(
                MaskPoint(
                    center.x + (spot.radius * cos(angle)).toFloat(),
                    center.y + (spot.radius * aspect * sin(angle)).toFloat(),
                )
            )
        }

    private fun assertFootprintIsTheProjectedCircle(back: MaskProjection) {
        val drawn = repairFootprint(spot.center, spot.radius, aspect, screen(back))
        val want = expected(back, spot.center)
        assertEquals(want.size, drawn.size)
        want.zip(drawn).forEach { (e, a) ->
            assertEquals(e.x.toDouble(), a.x.toDouble(), 1e-4)
            assertEquals(e.y.toDouble(), a.y.toDouble(), 1e-4)
        }
        // Not a screen circle: the horizontal and vertical extents differ.
        val width = drawn.maxOf { it.x } - drawn.minOf { it.x }
        val height = drawn.maxOf { it.y } - drawn.minOf { it.y }
        assertTrue("footprint $width x $height is a screen circle", kotlin.math.abs(width - height) > 1f)
    }

    @Test
    fun aNonUniformStretchProjectsTheFootprintInsteadOfAScreenCircle() {
        // Aspect +100's warp shape: x stretched 1.5x, y squeezed by 1/1.5.
        val back = MaskProjection(doubleArrayOf(1.5, 0.0, 0.0, 0.0, 1.0 / 1.5, 0.0, 0.0, 0.0, 1.0))
        assertFootprintIsTheProjectedCircle(back)

        val toScreen = screen(back)
        val footprint = { center: MaskPoint, s: RepairSpot -> repairFootprint(center, s.radius, aspect, toScreen) }
        val centre = toScreen(spot.center)
        // The old screen circle used the horizontal radius (45px) in every direction; a tap
        // 30px below centre is inside that circle but outside the projected footprint
        // (vertical semi-axis 20px), so it must place a new spot, not grab this one.
        assertNull(hitRepair(listOf(spot), null, MaskPoint(centre.x, centre.y + 30f), 5f, toScreen, footprint))
        // Inside the footprint it grabs the destination; the selected source is its own disc.
        assertEquals(
            0 to RepairHandle.Destination,
            hitRepair(listOf(spot), null, MaskPoint(centre.x, centre.y + 15f), 5f, toScreen, footprint),
        )
        val source = toScreen(spot.source)
        assertEquals(
            0 to RepairHandle.Source,
            hitRepair(listOf(spot), 0, MaskPoint(source.x, centre.y + 15f), 5f, toScreen, footprint),
        )
        assertFalse(repairFootprintContains(MaskPoint(source.x, centre.y + 30f), footprint(spot.source, spot)))
    }

    @Test
    fun aKeystoneProjectsTheFootprintInsteadOfAScreenCircle() {
        // A projective warp: the bottom of the frame is stretched wider than the top.
        val back = MaskProjection(doubleArrayOf(1.0, .15, 0.0, 0.0, 1.0, 0.0, 0.0, -.4, 1.0))
        assertFootprintIsTheProjectedCircle(back)

        val drawn = repairFootprint(spot.center, spot.radius, aspect, screen(back))
        val top = drawn.filter { it.y < screen(back)(spot.center).y }
        val bottom = drawn.filter { it.y > screen(back)(spot.center).y }
        assertTrue(
            "keystone footprint is symmetric",
            bottom.maxOf { it.x } - bottom.minOf { it.x } > top.maxOf { it.x } - top.minOf { it.x } + 1f,
        )
    }
}
