package app.justmaple.aperture.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.unit.dp
import app.justmaple.aperture.addMaskLayer
import app.justmaple.aperture.armMaskPick
import app.justmaple.aperture.data.LinearMask
import app.justmaple.aperture.data.MaskLayer
import app.justmaple.aperture.data.RadialMask
import app.justmaple.aperture.data.XmpDocument
import app.justmaple.aperture.maskLayers
import app.justmaple.aperture.removeMaskLayer
import app.justmaple.aperture.sampleMaskRangeAt
import app.justmaple.aperture.selectMaskLayer
import kotlin.math.PI
import kotlinx.coroutines.CompletableDeferred
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
 * Handle drags on the real overlay drive the real ViewModel and history: one drag is
 * one undo entry opened on its first movement, and each handle moves its part of
 * the mask. Only the JNI renderer is faked (identity crop map, full weights).
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class MaskOverlayTest {
    @get:Rule val compose = createComposeRule()

    private lateinit var fixture: MaskFixture
    private val model get() = fixture.model

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        fixture = MaskFixture("mask-overlay-")
    }

    @After
    fun tearDown() {
        fixture.close()
        Dispatchers.resetMain()
    }

    private fun showOverlay() {
        compose.setContent {
            val state by model.state.collectAsState()
            Box(Modifier.size(300.dp, 200.dp)) { MaskOverlay(model, state, zoom = 1f) }
        }
    }

    private fun layer(): MaskLayer = compose.runOnIdle { model.maskLayers().single() }

    private fun document(): XmpDocument = compose.runOnIdle { model.state.value.document }

    /** The handle's centre in the overlay's own coordinates. */
    private fun handleAt(handle: MaskHandle): Offset {
        val overlay = compose.onNodeWithTag("editor-mask-overlay").fetchSemanticsNode().boundsInRoot
        val pin = compose.onNodeWithTag("editor-mask-handle-${handle.id}").fetchSemanticsNode().boundsInRoot
        return pin.center - overlay.topLeft
    }

    /** Drags [handle] by [delta] px in three moves, then checks it was one undo entry. */
    private fun dragIsOneEntry(handle: MaskHandle, delta: Offset) {
        val before = document()
        val start = handleAt(handle)
        compose.onNodeWithTag("editor-mask-overlay").performTouchInput {
            down(start)
            moveBy(delta / 3f)
            moveBy(delta / 3f)
            moveBy(delta / 3f)
            up()
        }
        val after = document()
        assertNotEquals(before, after)
        compose.runOnIdle { model.undo() }
        assertEquals("One drag is one undo entry", before, document())
        compose.runOnIdle { model.redo() }
        assertEquals(after, document())
    }

    private fun size(): Offset =
        compose.onNodeWithTag("editor-mask-overlay").fetchSemanticsNode().boundsInRoot.let {
            Offset(it.width, it.height)
        }

    @Test
    fun linearHandlesMoveTheirEndAndTheWholeGradient() {
        compose.runOnIdle { model.addMaskLayer(radial = false) }
        showOverlay()
        compose.onNodeWithTag("editor-mask-overlay")
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Linear gradient mask"))
        compose.onNodeWithContentDescription("Mask handle: gradient end").assertExists()
        compose.runOnIdle { assertTrue("The tint reads raw-core's weights", fixture.renderer.weightRequests > 0) }
        val size = size()
        val initial = layer().shape as LinearMask

        dragIsOneEntry(MaskHandle.LinearEnd, Offset(30f, 24f))
        val ended = layer().shape as LinearMask
        assertEquals(initial.start, ended.start)
        assertEquals(initial.end.x + 30f / size.x, ended.end.x, 1e-3f)
        assertEquals(initial.end.y + 24f / size.y, ended.end.y, 1e-3f)

        dragIsOneEntry(MaskHandle.LinearBody, Offset(-30f, 0f))
        val moved = layer().shape as LinearMask
        assertEquals(ended.start.x - 30f / size.x, moved.start.x, 1e-3f)
        assertEquals(ended.end.x - 30f / size.x, moved.end.x, 1e-3f)
        assertEquals(ended.start.y, moved.start.y, 1e-4f)
    }

    @Test
    fun radialHandlesTranslateResizeAndRotate() {
        compose.runOnIdle { model.addMaskLayer(radial = true) }
        showOverlay()
        compose.onNodeWithTag("editor-mask-overlay")
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Radial mask"))
        val size = size()
        val initial = layer().shape as RadialMask

        dragIsOneEntry(MaskHandle.RadialCenter, Offset(15f, -12f))
        val centred = layer().shape as RadialMask
        assertEquals(initial.center.x + 15f / size.x, centred.center.x, 1e-3f)
        assertEquals(initial.center.y - 12f / size.y, centred.center.y, 1e-3f)
        assertEquals(initial.radii, centred.radii)

        dragIsOneEntry(MaskHandle.RadialRadiusX, Offset(12f, 0f))
        val wider = layer().shape as RadialMask
        assertEquals(centred.radii.x + 12f / size.x, wider.radii.x, 1e-3f)
        assertEquals(centred.radii.y, wider.radii.y, 1e-6f)

        val rotate = handleAt(MaskHandle.RadialRotate)
        val pivot = handleAt(MaskHandle.RadialCenter)
        dragIsOneEntry(MaskHandle.RadialRotate, Offset(pivot.x - rotate.x, (rotate.x - pivot.x)))
        val turned = layer().shape as RadialMask
        assertTrue("A rotation drag turns the ellipse", kotlin.math.abs(turned.angle) in .1f..(PI.toFloat() - .1f))
        assertEquals(wider.center, turned.center)
    }

    @Test
    fun aPressAwayFromTheHandlesAndAStillPressWriteNothing() {
        compose.runOnIdle { model.addMaskLayer(radial = false) }
        showOverlay()
        val before = document()
        compose.onNodeWithTag("editor-mask-overlay").performTouchInput {
            down(Offset(4f, height - 4f))
            moveBy(Offset(40f, -20f))
            up()
        }
        val pin = handleAt(MaskHandle.LinearStart)
        compose.onNodeWithTag("editor-mask-overlay").performTouchInput {
            down(pin)
            up()
        }
        assertEquals(before, document())
    }

    @Test
    fun aSampleTakenBeforeItsLayerWasDeletedNeverLandsOnTheNextLayer() {
        val gate = CompletableDeferred<Unit>()
        fixture.renderer.sampleGate = gate
        compose.runOnIdle {
            model.addMaskLayer(radial = true)
            model.addMaskLayer(radial = false)
            model.selectMaskLayer(0)
            model.sampleMaskRangeAt(.5f, .5f)
            assertTrue(model.state.value.maskSampling)
            model.removeMaskLayer(0)
            assertEquals("The selection now addresses the other layer", 0, model.state.value.maskSelection)
            gate.complete(Unit)
        }
        compose.runOnIdle {
            assertFalse(model.state.value.maskSampling)
            assertNull(model.maskLayers().single().range)
            assertEquals("The masks changed while sampling. Pick again.", model.state.value.maskMessage)
        }
    }

    @Test
    fun noSelectionMountsEmptyAndTheEyedropperSamplesTheTappedPoint() {
        compose.runOnIdle {
            model.addMaskLayer(radial = true)
            model.selectMaskLayer(null)
        }
        showOverlay()
        compose.onNodeWithTag("editor-mask-overlay")
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "No mask selected"))
        compose.onNodeWithTag("editor-mask-handle-radialCenter").assertDoesNotExist()

        compose.runOnIdle {
            model.selectMaskLayer(0)
            model.armMaskPick(true)
            assertTrue(model.state.value.maskPicking)
        }
        val before = document()
        compose.onNodeWithTag("editor-mask-overlay").performTouchInput {
            down(Offset(width * .25f, height * .75f))
            up()
        }
        compose.runOnIdle {
            val (x, y) = fixture.renderer.samples.single()
            assertEquals(.25f, x, 1e-2f)
            assertEquals(.75f, y, 1e-2f)
            assertFalse(model.state.value.maskPicking)
            assertEquals(40f, layer().range!!.getValue("hue_deg"), 1e-4f)
            model.undo()
        }
        assertEquals("A seed is one undo entry", before, document())
    }
}
