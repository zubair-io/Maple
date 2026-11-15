package app.justmaple.aperture.ui

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.junit4.createComposeRule
import app.justmaple.aperture.generated.CanvasZoomAbi.OP_STEP_ZOOM_IN
import app.justmaple.aperture.generated.CanvasZoomAbi.OP_STEP_ZOOM_OUT
import app.justmaple.aperture.generated.CanvasZoomAbi.OP_ZOOM_TO_FIT
import app.justmaple.aperture.generated.CanvasZoomAbi.OP_ZOOM_TO_SCALE
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Keyboard zoom and Reset Visible Group reach the composed canvas and editor (#5945). */
@RunWith(RobolectricTestRunner::class)
class CanvasZoomKeysTest {
    @get:Rule val compose = createComposeRule()

    private val native = RecordingCanvasZoom()

    @Test
    fun eachCommandSendsItsSharedModelTransitionAboutTheViewportCentre() {
        val zoom = CanvasZoomState(native)
        val expected = mapOf(
            CanvasZoomCommand.Fit to (OP_ZOOM_TO_FIT to 0.0),
            CanvasZoomCommand.ActualSize to (OP_ZOOM_TO_SCALE to 1.0),
            CanvasZoomCommand.ZoomIn to (OP_STEP_ZOOM_IN to 0.0),
            CanvasZoomCommand.ZoomOut to (OP_STEP_ZOOM_OUT to 0.0),
        )
        for ((command, transition) in expected) {
            native.calls.clear()
            zoom.command(command, 4000, 3000, 1000f, 750f)
            val call = native.calls.single()
            assertEquals(command.name, transition.first, call.op)
            assertArrayEquals(doubleArrayOf(transition.second, 0.0, 0.0, 0.0), call.args, 0.0)
            assertEquals(1000.0 to 750.0, call.viewport)
            assertEquals(4000.0 to 3000.0, call.image)
            assertEquals(500f to 375f, zoom.anchor)
        }
    }

    @Test
    fun theCanvasOffersItsZoomUntilTheCropToolLocksItOrItLeaves() {
        val targets = PhotoKeyTargets()
        val zoom = CanvasZoomState(native)
        var locked by mutableStateOf(false)
        var shown by mutableStateOf(true)
        var viewport by mutableStateOf(1000f to 750f)
        var image = 2048 to 1536
        compose.setContent {
            CompositionLocalProvider(LocalPhotoKeyTargets provides targets) {
                if (shown) CanvasZoomKeys(zoom, locked, { image }, viewport.first, viewport.second)
            }
        }
        compose.runOnIdle {
            image = 4000 to 3000
            viewport = 1200f to 900f
        }
        compose.runOnIdle {
            targets.zoom!!(CanvasZoomCommand.ZoomIn)
            val call = native.calls.single()
            assertEquals("sizes are read when the key arrives", 4000.0 to 3000.0, call.image)
            assertEquals(1200.0 to 900.0, call.viewport)
            locked = true
        }
        compose.runOnIdle {
            assertNull("the crop tool holds the zoom at fit", targets.zoom)
            locked = false
        }
        compose.runOnIdle {
            assertNotNull("leaving the crop tool offers the zoom again", targets.zoom)
            shown = false
        }
        compose.runOnIdle { assertNull(targets.zoom) }
    }

    @Test
    fun theEditorOffersOnlyTheGroupItShows() {
        val targets = PhotoKeyTargets()
        var group by mutableStateOf<EditorGroup?>(EditorGroup.Light)
        compose.setContent {
            CompositionLocalProvider(LocalPhotoKeyTargets provides targets) { VisibleGroupKeys(group) }
        }
        compose.runOnIdle {
            assertEquals(EditorGroup.Light, targets.visibleGroup)
            group = EditorGroup.Color
        }
        compose.runOnIdle {
            assertEquals(EditorGroup.Color, targets.visibleGroup)
            group = null
        }
        compose.runOnIdle { assertNull(targets.visibleGroup) }
    }
}
