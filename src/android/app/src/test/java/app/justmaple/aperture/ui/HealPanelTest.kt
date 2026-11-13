package app.justmaple.aperture.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.SemanticsNodeInteraction
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.filterToOne
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onChildren
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.unit.dp
import app.justmaple.aperture.data.MaskPoint
import app.justmaple.aperture.data.RepairKind
import app.justmaple.aperture.data.RepairSpot
import app.justmaple.aperture.data.XmpDocument
import app.justmaple.aperture.placeRepair
import app.justmaple.aperture.RepairBrush
import app.justmaple.aperture.repairSpots
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.runBlocking
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
 * The real Heal panel drives the real ViewModel, undo history and PhotoLibrary sidecar
 * writer; only the JNI renderer (and raw-core's repair codec behind it) is faked. Every
 * command is exactly one undo entry, a slider drag is one entry, and selection adds none.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class HealPanelTest {
    @get:Rule val compose = createComposeRule()

    private lateinit var fixture: MaskFixture
    private val model get() = fixture.model

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
    }

    @After
    fun tearDown() {
        fixture.close()
        Dispatchers.resetMain()
    }

    private fun showPanel(raw: Boolean = true) {
        fixture = MaskFixture("heal-panel-", raw)
        compose.setContent {
            val state by model.state.collectAsState()
            Column(Modifier.size(360.dp, 720.dp).verticalScroll(rememberScrollState())) { HealPanel(model, state) }
        }
    }

    private fun spots(): List<RepairSpot> = compose.runOnIdle { model.repairSpots() }

    private fun document(): XmpDocument = compose.runOnIdle { model.state.value.document }

    private fun click(tag: String) = compose.onNodeWithTag(tag).performScrollTo().performClick()

    private fun slider(tag: String): SemanticsNodeInteraction =
        compose.onNodeWithTag(tag).performScrollTo().onChildren()
            .filterToOne(SemanticsMatcher.keyIsDefined(SemanticsActions.SetProgress))

    private fun place(x: Float, y: Float) = compose.runOnIdle { model.placeRepair(MaskPoint(x, y)) }

    /** [action] changes the document by exactly one undo entry. */
    private fun oneEntry(action: () -> Unit) {
        val before = document()
        action()
        val after = document()
        assertNotEquals("The command edits the document", before, after)
        compose.runOnIdle { model.undo() }
        assertEquals("One undo step returns to the document before the command", before, document())
        compose.runOnIdle { model.redo() }
        assertEquals(after, document())
    }

    @Test
    fun everyPanelCommandIsOneUndoEntryAndSelectionIsNone() {
        showPanel()
        compose.onNodeWithTag("editor-heal-empty").assertExists()
        compose.onNodeWithTag("editor-heal-kind-heal").assertIsSelected()

        oneEntry { place(.2f, .3f) }
        oneEntry { place(.7f, .6f) }
        compose.onNodeWithTag("editor-heal-row-1").assertIsSelected()
        compose.onNodeWithContentDescription("Delete Heal 2").assertExists()

        // Selecting a row writes nothing and adds no history: undo still removes the second spot.
        val beforeSelect = document()
        click("editor-heal-row-0")
        compose.onNodeWithTag("editor-heal-row-0").assertIsSelected()
        assertEquals(beforeSelect, document())
        compose.runOnIdle { model.undo() }
        assertEquals(1, spots().size)
        compose.runOnIdle { model.redo() }
        assertEquals(2, spots().size)

        oneEntry { click("editor-heal-kind-clone") }
        assertEquals(RepairKind.Clone, spots()[0].kind)
        assertEquals("The other spot keeps its kind", RepairKind.Heal, spots()[1].kind)
        compose.onNodeWithContentDescription("Clone mode").assertIsSelected()
        compose.onNodeWithTag("editor-heal-row-0").assertExists()
        compose.onNodeWithContentDescription("Clone 1").assertExists()

        oneEntry {
            slider("editor-heal-size").performTouchInput {
                down(centerLeft)
                moveBy(Offset(width * .2f, 0f))
                moveBy(Offset(width * .2f, 0f))
                moveBy(Offset(width * .2f, 0f))
                up()
            }
        }
        assertTrue("A size drag grows the selected spot", spots()[0].radius > .05f)
        assertEquals(.02f, spots()[1].radius, 1e-6f)
        oneEntry {
            slider("editor-heal-feather").performSemanticsAction(SemanticsActions.SetProgress) { it(.8f) }
        }
        assertEquals(.8f, spots()[0].feather, 1e-4f)
        oneEntry {
            slider("editor-heal-opacity").performSemanticsAction(SemanticsActions.SetProgress) { it(.4f) }
        }
        assertEquals(.4f, spots()[0].opacity, 1e-4f)
        compose.onNodeWithTag("editor-heal-row-0").assertExists()

        // The brush follows the selection: the next placement uses the selected spot's shape.
        oneEntry { place(.5f, .9f) }
        val placed = spots()[2]
        assertEquals(RepairKind.Clone, placed.kind)
        assertEquals(.8f, placed.feather, 1e-4f)
        assertEquals(.4f, placed.opacity, 1e-4f)

        oneEntry { click("editor-heal-delete-0") }
        assertEquals(2, spots().size)
        compose.runOnIdle { assertEquals("The selection follows the removed row", 1, model.state.value.healSelection) }

        oneEntry { click("editor-heal-reset") }
        assertTrue(spots().isEmpty())
        compose.onNodeWithTag("editor-heal-empty").assertExists()
        compose.runOnIdle {
            assertNull(model.state.value.healSelection)
            assertNull("An emptied list drops the frame stamp", model.state.value.document.attribute("papp:RetouchFrameVersion"))
        }

        compose.runOnIdle { model.undo() }
        assertTrue(runBlocking { model.flush() })
        val saved = runBlocking { fixture.library.loadSidecar(fixture.photo) }.document
        assertEquals(spots(), model.repairSpots(saved))
        assertTrue(saved.original.contains("<crs:RetouchAreas>"))
        assertEquals("2", saved.attribute("papp:RetouchFrameVersion"))
    }

    @Test
    fun deletingTheSelectedSpotLoadsItsNeighbourIntoThePanel() {
        showPanel()
        place(.2f, .3f)
        place(.7f, .6f)
        click("editor-heal-row-0")
        click("editor-heal-kind-clone")
        slider("editor-heal-opacity").performSemanticsAction(SemanticsActions.SetProgress) { it(.4f) }
        compose.onNodeWithContentDescription("Clone mode").assertIsSelected()

        click("editor-heal-delete-0")
        val heal = spots().single()
        assertEquals(RepairKind.Heal, heal.kind)
        compose.runOnIdle {
            assertEquals(0, model.state.value.healSelection)
            assertEquals(
                "The panel describes the spot now selected",
                RepairBrush(heal.kind, heal.radius, heal.feather, heal.opacity),
                model.state.value.healBrush,
            )
        }
        compose.onNodeWithContentDescription("Heal mode").assertIsSelected()
        // A slider edit changes only that setting of the selected spot.
        slider("editor-heal-feather").performSemanticsAction(SemanticsActions.SetProgress) { it(.8f) }
        val edited = spots().single()
        assertEquals(.8f, edited.feather, 1e-4f)
        assertEquals(heal.copy(feather = edited.feather), edited)
    }

    @Test
    fun aRasterPhotoCannotAuthorRepairSpots() {
        showPanel(raw = false)
        compose.onNodeWithTag("editor-heal-kind-clone").assertIsNotEnabled()
        compose.onNodeWithContentDescription("Size").assertIsNotEnabled()
        assertNull(place(.5f, .5f))
        assertTrue(spots().isEmpty())
        compose.runOnIdle { assertFalse(model.state.value.canUndo) }
    }

    @Test
    fun theInspectorOffersHealOnlyForRawsAndTheCanvasArmsItAtFit() {
        fixture = MaskFixture("heal-wiring-")
        val zoom = CanvasZoomState(RecordingCanvasZoom())
        var tool by mutableStateOf<String?>(null)
        compose.setContent {
            val state by model.state.collectAsState()
            Column {
                Box(Modifier.size(360.dp, 480.dp)) {
                    ControlsInspector(model, state, EditorGroup.Detail, Modifier, activeSubTool = tool,
                        onSubToolChange = { tool = it })
                }
                Box(Modifier.size(300.dp, 200.dp)) {
                    PhotoCanvas(model, state, onHistogram = {}, zoomState = zoom,
                        canvasTool = canvasToolFor(true, EditorGroup.Detail, tool.orEmpty(), state.values["_raw"] == 1f))
                }
            }
        }
        compose.onNodeWithTag("editor-heal-overlay").assertDoesNotExist()
        compose.runOnIdle { zoom.doubleTap(150f, 100f, 3000, 2000, 300f, 200f) }
        compose.runOnIdle { assertTrue(zoom.isZoomed) }
        compose.onNodeWithTag("sub-tool-heal").performClick()
        compose.onNodeWithTag("editor-heal-scroll").assertExists()
        compose.onNodeWithTag("adjustment-sliders").assertDoesNotExist()
        compose.runOnIdle { assertFalse("Arming the heal tool snaps to fit", zoom.isZoomed) }
        compose.onNodeWithTag("editor-heal-overlay").assertExists()
    }

    @Test
    fun aRasterInspectorHasNoHealSubTool() {
        fixture = MaskFixture("heal-raster-", rawSource = false)
        compose.setContent {
            val state by model.state.collectAsState()
            Box(Modifier.size(360.dp, 640.dp)) {
                ControlsInspector(model, state, EditorGroup.Detail, Modifier, activeSubTool = "heal")
            }
        }
        compose.onNodeWithTag("sub-tool-heal").assertDoesNotExist()
        compose.onNodeWithTag("editor-heal-scroll").assertDoesNotExist()
        compose.onNodeWithTag("adjustment-sliders").assertExists()
    }
}
