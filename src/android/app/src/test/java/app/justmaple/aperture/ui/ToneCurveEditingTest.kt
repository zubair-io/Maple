package app.justmaple.aperture.ui

import app.justmaple.aperture.data.CurveKnot
import org.junit.Assert.*
import org.junit.Test

/** Mirrors Apple's `ToneCurveMathTests` editing cases so both editors keep one list grammar. */
class ToneCurveEditingTest {
    private val three = ToneCurveEditing.insert(emptyList(), .5f, .5f)

    @Test
    fun identityMaterializesAsSortedCornerAnchors() {
        assertEquals(listOf(CurveKnot(0f, 0f), CurveKnot(1f, 1f)), ToneCurveEditing.materialize(emptyList()))
        assertEquals(listOf(.2f, .8f), ToneCurveEditing.materialize(listOf(CurveKnot(.8f, .9f), CurveKnot(.2f, .1f))).map { it.x })
    }

    @Test
    fun insertNeverLeavesALoneKnotRefusesCollisionsAndClamps() {
        assertEquals(listOf(0f, .5f, 1f), three.map { it.x })
        assertEquals(three, ToneCurveEditing.insert(three, .5f + ToneCurveEditing.MIN_X_GAP / 2, .2f))
        assertEquals(1f, ToneCurveEditing.insert(emptyList(), .5f, 1.8f)[1].y)
        assertEquals(0f, ToneCurveEditing.insert(emptyList(), .5f, -.4f)[1].y)
    }

    @Test
    fun movePinsEndpointsInXAndHoldsInteriorKnotsOffTheirNeighbours() {
        assertEquals(CurveKnot(.7f, .3f), ToneCurveEditing.move(three, 1, .7f, .3f)[1])
        assertEquals(CurveKnot(0f, .25f), ToneCurveEditing.move(three, 0, .4f, .25f)[0])
        assertEquals(CurveKnot(1f, .8f), ToneCurveEditing.move(three, 2, .4f, .8f)[2])
        assertEquals(ToneCurveEditing.MIN_X_GAP, ToneCurveEditing.move(three, 1, -5f, .5f)[1].x, 1e-7f)
        assertEquals(1f - ToneCurveEditing.MIN_X_GAP, ToneCurveEditing.move(three, 1, 5f, .5f)[1].x, 1e-7f)
        assertEquals(3, ToneCurveEditing.move(three, 9, .5f, .5f).size)
    }

    @Test
    fun removeKeepsEndpointsAndCollapsesToTheEmptyIdentity() {
        val four = ToneCurveEditing.insert(ToneCurveEditing.insert(emptyList(), .3f, .2f), .7f, .8f)
        assertEquals(listOf(0f, .7f, 1f), ToneCurveEditing.remove(four, 1).map { it.x })
        assertEquals(3, ToneCurveEditing.remove(three, 0).size)
        assertEquals(3, ToneCurveEditing.remove(three, 2).size)
        assertTrue(ToneCurveEditing.remove(three, 1).isEmpty())
        val lifted = ToneCurveEditing.move(three, 2, 1f, .8f)
        assertEquals(listOf(CurveKnot(0f, 0f), CurveKnot(1f, .8f)), ToneCurveEditing.remove(lifted, 1))
    }

    @Test
    fun hitTestFindsKnotsIncludingTheMaterializedAnchors() {
        assertEquals(1, ToneCurveEditing.hitTest(three, .51f, .49f, .05f))
        assertNull(ToneCurveEditing.hitTest(three, .2f, .9f, .05f))
        assertEquals(0, ToneCurveEditing.hitTest(emptyList(), .01f, .01f, .05f))
        assertEquals(1, ToneCurveEditing.hitTest(emptyList(), .99f, .99f, .05f))
    }

    @Test
    fun familiesNameTheirChannelsAndOnlyTheSceneFamilyShowsRegionSliders() {
        assertEquals("Luma", ToneCurveFamily.Scene.channelLabel(0))
        assertEquals("Master", ToneCurveFamily.Display.channelLabel(0))
        assertEquals(listOf("papp:SceneLinearToneCurve", "papp:SceneLinearToneCurveRed", "papp:SceneLinearToneCurveGreen", "papp:SceneLinearToneCurveBlue"),
            ToneCurveFamily.Scene.curves.map { it.element })
        assertEquals("crs:ToneCurvePV2012Blue", ToneCurveFamily.Display.curves[3].element)
        assertEquals(toneCurveFields, toneCurveSliders(ToneCurveFamily.Scene))
        assertTrue(toneCurveSliders(ToneCurveFamily.Display).isEmpty())
    }

    @Test
    fun parametricSplitMarkersUseTheCoreLogarithmicAxis() {
        assertEquals(0.01125f, parametricAxisToAuthoringX(25f), 1e-4f)
        assertEquals(0.045f, parametricAxisToAuthoringX(50f), 1e-4f)
        assertEquals(0.18f, parametricAxisToAuthoringX(75f), 1e-4f)
        assertEquals(Triple(49f, 50f, 51f), orderedParametricSplits(60f, 50f, 40f))
    }
}
