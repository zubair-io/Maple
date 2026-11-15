package app.justmaple.aperture.ui

import app.justmaple.aperture.data.MaskPoint
import org.junit.Assert.*
import org.junit.Test
import kotlin.math.cos
import kotlin.math.sin

class MaskProjectionBoundsTest {
    private fun projection(): MaskProjection {
        val angle = Math.toRadians(10.0)
        val c = cos(angle)
        val s = sin(angle)
        val tx = (1 - c - s) / 2
        val ty = (1 + s - c) / 2
        return MaskProjection(doubleArrayOf(
            c / 1.5, s / 1.5, tx / 1.5 + 1.0 / 6,
            -s / 1.5, c / 1.5, ty / 1.5 + 1.0 / 6,
            0.0, 0.0, 1.0,
            c, s, tx, -s, c, ty, 0.0, 0.0, 1.0,
        ))
    }

    @Test fun rejectsIntermediateCropCornerDespiteValidSourcePoint() {
        val map = projection()
        val corner = map.apply(MaskPoint(.01f, .01f))
        assertTrue(corner.x.isNaN())
        assertTrue(corner.y.isNaN())
        assertEquals(.5f, map.apply(MaskPoint(.5f, .5f)).x, 1e-6f)
    }

    @Test fun healFootprintCannotBePickedThroughEmptyCropCorner() {
        val map = projection()
        val footprint = repairFootprint(MaskPoint(.122f, .235f), .03f, 1f) { it }
        assertFalse(repairFootprintContains(map.apply(MaskPoint(.01f, .01f)), footprint))
        assertTrue(repairFootprintContains(MaskPoint(.122f, .235f), footprint))
    }
}
