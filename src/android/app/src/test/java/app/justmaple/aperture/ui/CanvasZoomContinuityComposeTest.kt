package app.justmaple.aperture.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createComposeRule
import app.justmaple.aperture.PhotoMode
import app.justmaple.aperture.data.NativeImageSize
import app.justmaple.aperture.generated.CanvasZoomAbi.OP_ADOPT_IMAGE
import app.justmaple.aperture.generated.CanvasZoomAbi.OP_RECLAMP
import app.justmaple.aperture.generated.CanvasZoomAbi.OP_REFRAME_IMAGE
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** The canvas's zoom wiring across the three events in #5748, composed as the canvas composes it. */
@RunWith(RobolectricTestRunner::class)
class CanvasZoomContinuityComposeTest {
    @get:Rule val compose = createComposeRule()

    private val native = RecordingCanvasZoom()
    private val photo = "content://photos/a.dng:100:1"
    private val placeholder = 2048 to 1536

    private data class Canvas(
        val scope: CanvasZoomScope,
        val size: NativeImageSize?,
        val crop: CropRect,
        val viewport: Pair<Float, Float>,
    )

    private val portrait = Canvas(CanvasZoomScope(photo, PhotoMode.Edit, cropTool = false),
        NativeImageSize(4000, 3000), CropRect(), 1000f to 750f)

    private fun CanvasZoomState.zoomIn() = compose.runOnIdle {
        doubleTap(500f, 375f, 4000, 3000, 1000f, 750f)
        native.calls.clear()
    }

    @Test
    fun aFoldPostureThatComposesTheCanvasElsewhereKeepsTheZoom() {
        val zoom = CanvasZoomState(native)
        var tabletop by mutableStateOf(false)
        var canvas by mutableStateOf(portrait)
        compose.setContent {
            val placed = canvas
            if (tabletop) Column {
                Box {}
                CanvasZoomContinuity(zoom, placed.scope, placed.size, placed.crop, placeholder,
                    placed.viewport.first, placed.viewport.second)
            }
            else CanvasZoomContinuity(zoom, placed.scope, placed.size, placed.crop, placeholder,
                placed.viewport.first, placed.viewport.second)
        }
        zoom.zoomIn()
        compose.runOnIdle {
            tabletop = true
            canvas = portrait.copy(viewport = 1000f to 360f)
        }
        compose.runOnIdle {
            assertTrue(zoom.isZoomed)
            assertEquals(1f, zoom.pixelScale)
            val call = native.calls.single()
            assertEquals(OP_RECLAMP, call.op)
            assertEquals(1000.0 to 360.0, call.viewport)
        }
    }

    @Test
    fun aRecreatedActivityKeepsTheZoomAndReclampsForTheNewViewport() {
        val restoration = StateRestorationTester(compose)
        var canvas by mutableStateOf(portrait)
        var zoom: CanvasZoomState? = null
        restoration.setContent {
            val state = rememberCanvasZoomState(native)
            zoom = state
            val placed = canvas
            CanvasZoomContinuity(state, placed.scope, placed.size, placed.crop, placeholder,
                placed.viewport.first, placed.viewport.second)
        }
        zoom!!.zoomIn()
        restoration.emulateSavedInstanceStateRestore()
        compose.runOnIdle {
            assertTrue(zoom!!.isZoomed)
            assertEquals(-120f, zoom!!.panX)
            assertEquals("no re-adoption or reset after the restore", setOf(OP_RECLAMP),
                native.calls.map { it.op }.toSet())
            canvas = portrait.copy(viewport = 750f to 1000f)
        }
        compose.runOnIdle {
            assertTrue(zoom!!.isZoomed)
            assertEquals(OP_RECLAMP, native.calls.last().op)
            assertEquals(750.0 to 1000.0, native.calls.last().viewport)
        }
    }

    @Test
    fun undoingACropReframesTheZoom() {
        val zoom = CanvasZoomState(native)
        var canvas by mutableStateOf(portrait)
        compose.setContent {
            val placed = canvas
            CanvasZoomContinuity(zoom, placed.scope, placed.size, placed.crop, placeholder,
                placed.viewport.first, placed.viewport.second)
        }
        zoom.zoomIn()
        compose.runOnIdle {
            canvas = portrait.copy(size = NativeImageSize(3200, 3000), crop = CropRect(right = 0.8f))
        }
        compose.runOnIdle { canvas = portrait }
        compose.runOnIdle {
            assertTrue(zoom.isZoomed)
            assertEquals(listOf(OP_REFRAME_IMAGE, OP_REFRAME_IMAGE),
                native.calls.filter { it.op != OP_RECLAMP }.map { it.op })
        }
    }

    @Test
    fun openingAnotherPhotoReturnsToFitAndAdoptsItsSize() {
        val zoom = CanvasZoomState(native)
        var canvas by mutableStateOf(portrait)
        compose.setContent {
            val placed = canvas
            CanvasZoomContinuity(zoom, placed.scope, placed.size, placed.crop, placeholder,
                placed.viewport.first, placed.viewport.second)
        }
        zoom.zoomIn()
        compose.runOnIdle {
            canvas = portrait.copy(scope = portrait.scope.copy(photoKey = "other"),
                size = NativeImageSize(6000, 4000))
        }
        compose.runOnIdle {
            assertFalse(zoom.isZoomed)
            assertEquals(listOf(OP_ADOPT_IMAGE), native.calls.map { it.op })
            assertEquals(6000, zoom.frameFor("other")?.width)
        }
    }
}
