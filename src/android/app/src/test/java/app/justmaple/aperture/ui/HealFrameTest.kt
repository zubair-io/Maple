package app.justmaple.aperture.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.click
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.unit.dp
import app.justmaple.aperture.data.MaskPoint
import app.justmaple.aperture.placeRepair
import app.justmaple.aperture.removeRepair
import app.justmaple.aperture.repairSpots
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * The repair list's frame on the real ViewModel and overlay: the stamp follows what the codec
 * says still renders, a sensor-framed list reaches the codec with the RAW's orientation, and
 * the canvas places spots through the shared crop and manual-geometry frame map. Only the JNI
 * renderer is faked.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class HealFrameTest {
    @get:Rule val compose = createComposeRule()

    private var fixture: MaskFixture? = null

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
    }

    @After
    fun tearDown() {
        fixture?.close()
        Dispatchers.resetMain()
    }

    private fun open(sidecar: String? = null, orientation: Float = 1f) =
        MaskFixture("heal-frame-", sidecar = sidecar, orientation = orientation).also { fixture = it }

    private fun stamp(fixture: MaskFixture) =
        compose.runOnIdle { fixture.model.state.value.document.attribute("papp:RetouchFrameVersion") }

    @Test
    fun theStampStaysWhileSpotsAndroidDoesNotListStillRender() {
        val fixture = open()
        compose.runOnIdle { fixture.model.placeRepair(MaskPoint(.4f, .4f)) }
        assertEquals("2", stamp(fixture))
        fixture.renderer.repairsRemain = true
        compose.runOnIdle { fixture.model.removeRepair(0) }
        assertEquals("Retained repairs keep their upright frame", "2", stamp(fixture))
        fixture.renderer.repairsRemain = false
        compose.runOnIdle { fixture.model.placeRepair(MaskPoint(.4f, .4f)) }
        compose.runOnIdle { fixture.model.removeRepair(0) }
        assertNull("An emptied list drops the stamp", stamp(fixture))
    }

    @Test
    fun aSensorFramedListReachesTheCodecWithTheRawsOrientation() {
        val spot = """[{"kind":"heal","center":[0.3,0.4],"source":[0.35,0.4],"radius":0.02,"feather":0.5,"opacity":1}]"""
        val sidecar =
            """<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">""" +
                """<rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" """ +
                """xmlns:papp="http://ns.justmaple.app/photo/1.0/" papp:Profile="adobe-color">""" +
                """<crs:RetouchAreas>$spot</crs:RetouchAreas></rdf:Description></rdf:RDF></x:xmpmeta>"""
        val fixture = open(sidecar, orientation = 6f)
        assertTrue(compose.runOnIdle { fixture.model.state.value.document.repairsInSensorFrame })
        assertEquals(1, compose.runOnIdle { fixture.model.repairSpots() }.size)
        val frame = fixture.renderer.repairRead!!.getJSONObject("frame")
        assertEquals(6, frame.getInt("orientation"))
        assertEquals(1.5, frame.getDouble("aspect"), 1e-6)

        compose.runOnIdle { fixture.model.placeRepair(MaskPoint(.6f, .6f)) }
        assertEquals("The converted list is stamped upright", "2", stamp(fixture))
        assertFalse(compose.runOnIdle { fixture.model.state.value.document.repairsInSensorFrame })
    }

    @Test
    fun aTapPlacesTheSpotOnTheUprightPixelUnderTheManualPerspective() {
        val fixture = open()
        // Geometry Scale 150% about the centre: upright x = 2/3 is shown at x = 0.75. The
        // fake answers the shared frame map with that warp only for the photo's own Geometry.
        val scaled = geometryFields.map { if (it.name == "perspective_scale") 150f else it.initial }
        val identity = doubleArrayOf(1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0)
        fixture.renderer.frame = { _, geometry ->
            if (geometry == scaled) doubleArrayOf(2.0 / 3, 0.0, 1.0 / 6, 0.0, 2.0 / 3, 1.0 / 6, 0.0, 0.0, 1.0)
            else identity
        }
        compose.runOnIdle { fixture.model.setField("perspective_scale", 150f) }
        compose.setContent {
            val state by fixture.model.state.collectAsState()
            Box(Modifier.size(300.dp, 200.dp)) { HealOverlay(fixture.model, state, zoom = 1f) }
        }
        val bounds = compose.onNodeWithTag("editor-heal-overlay").fetchSemanticsNode().boundsInRoot
        compose.onNodeWithTag("editor-heal-overlay").performTouchInput {
            click(Offset(bounds.width * .75f, bounds.height * .5f))
        }
        val spot = compose.runOnIdle { fixture.model.repairSpots() }.single()
        assertEquals(2f / 3, spot.center.x, 1e-3f)
        assertEquals(.5f, spot.center.y, 1e-3f)
        val handle = compose.onNodeWithTag("editor-heal-spot-0").fetchSemanticsNode().boundsInRoot.center
        assertEquals("The handle sits where the spot renders", bounds.width * .75f, handle.x - bounds.left, 1f)
    }
}
