package app.justmaple.aperture.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.dp
import app.justmaple.aperture.addMaskLayer
import app.justmaple.aperture.maskLayers
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

/** The Mask sub-tool mounts the panel on both control surfaces and arms the canvas overlay at fit. */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(RobolectricTestRunner::class)
class MaskWiringTest {
    @get:Rule val compose = createComposeRule()

    private lateinit var fixture: MaskFixture
    private val model get() = fixture.model

    @Before
    fun setUp() {
        Dispatchers.setMain(UnconfinedTestDispatcher())
        fixture = MaskFixture("mask-wiring-")
    }

    @After
    fun tearDown() {
        fixture.close()
        Dispatchers.resetMain()
    }

    @Test
    fun theInspectorsMaskSubToolMountsTheScrollablePanel() {
        compose.setContent {
            val state by model.state.collectAsState()
            Box(Modifier.size(360.dp, 640.dp)) { ControlsInspector(model, state, EditorGroup.Detail, Modifier) }
        }
        compose.onNodeWithTag("adjustment-sliders").assertExists()
        compose.onNodeWithTag("sub-tool-mask").performClick()
        compose.onNodeWithTag("editor-mask-scroll").assertExists()
        compose.onNodeWithTag("adjustment-sliders").assertDoesNotExist()
        compose.onNodeWithTag("editor-mask-add-radial").performScrollTo().performClick()
        compose.runOnIdle { assertEquals(1, model.maskLayers().size) }
    }

    @Test
    fun thePhoneControlsMountThePanelWithoutADragBar() {
        var armed by mutableStateOf("sharpen_amount")
        compose.setContent {
            val state by model.state.collectAsState()
            Box(Modifier.size(400.dp, 600.dp)) {
                PhoneEditorControls(model, state, EditorGroup.Detail, armed, {}, { armed = it }, {}, activeSubTool = "mask")
            }
        }
        compose.onNodeWithTag("editor-mask-section").assertExists()
        compose.runOnIdle { assertEquals("", armed) }
        compose.onNodeWithTag("editor-mask-add-linear").performScrollTo().performClick()
        compose.runOnIdle { assertEquals(0, model.state.value.maskSelection) }
    }

    @Test
    fun armingTheMaskToolSnapsTheCanvasToFitAndShowsTheOverlay() {
        val zoom = CanvasZoomState(RecordingCanvasZoom())
        var armedTool by mutableStateOf(false)
        compose.runOnIdle { model.addMaskLayer(radial = true) }
        compose.setContent {
            val state by model.state.collectAsState()
            Box(Modifier.size(400.dp, 300.dp)) {
                PhotoCanvas(model, state, onHistogram = {}, zoomState = zoom,
                    canvasTool = CanvasTool.Mask.takeIf { armedTool })
            }
        }
        compose.onNodeWithTag("editor-mask-overlay").assertDoesNotExist()
        compose.runOnIdle { zoom.doubleTap(200f, 150f, 3000, 2000, 400f, 300f) }
        compose.runOnIdle { assertTrue(zoom.isZoomed) }
        compose.runOnIdle { armedTool = true }
        compose.runOnIdle { assertFalse("Arming the mask tool snaps to fit", zoom.isZoomed) }
        compose.onNodeWithTag("editor-mask-overlay").assertExists()
        compose.onNodeWithTag("editor-mask-handle-radialCenter").assertExists()
    }
}
