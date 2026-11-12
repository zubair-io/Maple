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
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.click
import androidx.compose.ui.unit.dp
import app.justmaple.aperture.data.RepairKind
import app.justmaple.aperture.data.RepairSpot
import app.justmaple.aperture.data.XmpDocument
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
 * Placement and handle drags on the real Heal overlay drive the real ViewModel, history and
 * sidecar document: a placement is one undo entry, a drag is one entry opened on its first
 * movement, and selection adds none. Only the JNI renderer is faked (identity crop map).
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class HealOverlayTest {
    @get:Rule val compose = createComposeRule()

    private lateinit var fixture: MaskFixture
    private val model get() = fixture.model

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        fixture = MaskFixture("heal-overlay-")
    }

    @After
    fun tearDown() {
        fixture.close()
        Dispatchers.resetMain()
    }

    /** 300 × 200 matches the photo's 1.5 aspect, so the overlay maps the frame exactly. */
    private fun showOverlay() {
        compose.setContent {
            val state by model.state.collectAsState()
            Box(Modifier.size(300.dp, 200.dp)) { HealOverlay(model, state, zoom = 1f) }
        }
    }

    private fun spots(): List<RepairSpot> = compose.runOnIdle { model.repairSpots() }

    private fun document(): XmpDocument = compose.runOnIdle { model.state.value.document }

    private fun size(): Offset =
        compose.onNodeWithTag("editor-heal-overlay").fetchSemanticsNode().boundsInRoot.let { Offset(it.width, it.height) }

    /** The handle's centre in the overlay's own coordinates. */
    private fun handleAt(tag: String): Offset {
        val overlay = compose.onNodeWithTag("editor-heal-overlay").fetchSemanticsNode().boundsInRoot
        return compose.onNodeWithTag(tag).fetchSemanticsNode().boundsInRoot.center - overlay.topLeft
    }

    private fun drag(from: Offset, delta: Offset) =
        compose.onNodeWithTag("editor-heal-overlay").performTouchInput {
            down(from)
            moveBy(delta / 3f)
            moveBy(delta / 3f)
            moveBy(delta / 3f)
            up()
        }

    private fun tap(at: Offset) = compose.onNodeWithTag("editor-heal-overlay").performTouchInput { click(at) }

    @Test
    fun aTapPlacesOneSpotWithTheBrushAndReloadsTheNativeModel() {
        showOverlay()
        compose.onNodeWithTag("editor-heal-overlay")
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "No repair spots"))
        val before = document()
        val reloads = compose.runOnIdle { fixture.renderer.invalidations }
        val size = size()
        tap(Offset(size.x * .5f, size.y * .5f))

        val spot = spots().single()
        assertEquals(RepairKind.Heal, spot.kind)
        assertEquals(.5f, spot.center.x, 1e-3f)
        assertEquals(.5f, spot.center.y, 1e-3f)
        assertEquals("The default source sits 1.5 radii to the right", .5f + spot.radius * 1.5f, spot.source.x, 1e-3f)
        assertEquals(.02f, spot.radius, 1e-6f)
        compose.runOnIdle {
            assertEquals(0, model.state.value.healSelection)
            assertTrue("A spot change reloads the native model", fixture.renderer.invalidations > reloads)
            assertTrue(fixture.renderer.latest!!.document.original.contains("crs:RetouchAreas"))
            assertEquals("2", model.state.value.document.attribute("papp:RetouchFrameVersion"))
        }
        compose.onNodeWithTag("editor-heal-overlay")
            .assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "1 repair spot"))
        compose.onNodeWithContentDescription("Repair spot Heal 1: destination").assertIsSelected()
        compose.onNodeWithContentDescription("Repair spot Heal 1: source").assertExists()

        compose.runOnIdle { model.undo() }
        assertEquals("A placement is one undo entry", before, document())
        assertTrue(spots().isEmpty())
    }

    @Test
    fun placingAndDraggingAimsTheSourceAsASecondEntry() {
        showOverlay()
        val size = size()
        drag(Offset(size.x * .3f, size.y * .3f), Offset(size.x * .3f, size.y * .2f))
        val spot = spots().single()
        assertEquals(.3f, spot.center.x, 1e-3f)
        assertEquals(.3f, spot.center.y, 1e-3f)
        assertEquals("The source follows the finger", .6f, spot.source.x, 1e-2f)
        assertEquals(.5f, spot.source.y, 1e-2f)

        compose.runOnIdle { model.undo() }
        val placed = spots().single()
        assertEquals("Undo reverts the whole aim drag at once", placed.center.x + placed.radius * 1.5f, placed.source.x, 1e-3f)
        compose.runOnIdle { model.undo() }
        assertTrue(spots().isEmpty())
    }

    @Test
    fun handleDragsMoveTheirPartsAsOneEntryAndSelectionAddsNone() {
        showOverlay()
        val size = size()
        tap(Offset(size.x * .25f, size.y * .5f))
        tap(Offset(size.x * .75f, size.y * .25f))
        assertEquals(2, spots().size)
        compose.runOnIdle { assertEquals(1, model.state.value.healSelection) }

        // Selecting the first spot writes nothing: undo still removes the second placement.
        val beforeSelect = document()
        tap(handleAt("editor-heal-spot-0"))
        compose.runOnIdle { assertEquals(0, model.state.value.healSelection) }
        assertEquals(beforeSelect, document())
        compose.onNodeWithTag("editor-heal-spot-0").assertIsSelected()

        val first = spots()[0]
        val beforeDrag = document()
        drag(handleAt("editor-heal-spot-0"), Offset(size.x * .1f, 0f))
        val moved = spots()[0]
        assertEquals(first.center.x + .1f, moved.center.x, 1e-2f)
        assertEquals("The destination carries its source", first.source.x + .1f, moved.source.x, 1e-2f)
        compose.runOnIdle { model.undo() }
        assertEquals("One drag is one undo entry", beforeDrag, document())
        compose.runOnIdle { model.redo() }

        val beforeSource = spots()[0]
        drag(handleAt("editor-heal-source"), Offset(0f, size.y * .2f))
        val aimed = spots()[0]
        assertEquals(beforeSource.center, aimed.center)
        assertEquals(beforeSource.source.y + .2f, aimed.source.y, 1e-2f)
        compose.runOnIdle { model.undo() }
        assertEquals(beforeSource, spots()[0])

        compose.runOnIdle { model.undo() }
        compose.runOnIdle { model.undo() }
        assertEquals("Selection added no entry in between", 1, spots().size)
    }

    @Test
    fun aSecondFingerLeavesTheGestureToCanvasZoom() {
        showOverlay()
        val size = size()
        compose.onNodeWithTag("editor-heal-overlay").performTouchInput {
            down(0, Offset(size.x * .3f, size.y * .5f))
            down(1, Offset(size.x * .7f, size.y * .5f))
            moveBy(1, Offset(size.x * .1f, 0f))
            up(1)
            up(0)
        }
        assertTrue("A pinch places no spot", spots().isEmpty())
    }
}
