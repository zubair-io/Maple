package app.justmaple.aperture

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.click
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.unit.dp
import app.justmaple.aperture.data.NativeImageSize
import app.justmaple.aperture.ui.CanvasZoomScope
import app.justmaple.aperture.ui.CanvasZoomState
import app.justmaple.aperture.ui.CropRect
import app.justmaple.aperture.ui.detectCanvasZoomPanAndSwipe
import app.justmaple.aperture.ui.rememberCanvasZoomState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** Rotation, fold posture and crop undo keep the zoom, through the real JNI binding (#5748). */
class CanvasZoomContinuityGestureTest {
    @get:Rule val compose = createComposeRule()

    private val photo = "content://photos/a.dng:100:1"

    private fun atActualSize(): CanvasZoomState =
        CanvasZoomState().apply {
            enterScope(CanvasZoomScope(photo, PhotoMode.Edit, cropTool = false))
            adoptImage(photo, NativeImageSize(4000, 3000), CropRect(), 4000, 3000, 1000f, 750f)
            doubleTap(700f, 375f, 4000, 3000, 1000f, 750f)
        }

    @Test
    fun aRecreatedActivityKeepsTheZoomAndPan() {
        val restoration = StateRestorationTester(compose)
        var zoom: CanvasZoomState? = null
        restoration.setContent { zoom = rememberCanvasZoomState() }
        val before = compose.runOnIdle {
            zoom!!.doubleTap(700f, 375f, 4000, 3000, 1000f, 750f)
            Triple(zoom!!.pixelScale, zoom!!.panX, zoom!!.panY)
        }
        assertEquals(1f, before.first)
        zoom = null
        restoration.emulateSavedInstanceStateRestore()
        compose.runOnIdle {
            assertEquals(before, Triple(zoom!!.pixelScale, zoom!!.panX, zoom!!.panY))
        }
    }

    @Test
    fun aRotationAtFillKeepsTheCentredPoint() {
        val zoom = CanvasZoomState()
        zoom.advanceStop(2000, 1000, 1000f, 750f)
        zoom.dragChanged(100f, 0f, 2000, 1000, 1000f, 750f)
        zoom.dragEnded()
        assertEquals(100f, zoom.panX, 1e-3f)
        zoom.reclamp(2000, 1000, 750f, 1000f)
        assertEquals(1f, zoom.pixelScale, 1e-6f)
        assertEquals("the same image point stays centred", 100f / 0.75f, zoom.panX, 1e-3f)
    }

    @Test
    fun aCropAndItsUndoKeepTheZoomAndTheCentredPoint() {
        val zoom = atActualSize()
        assertEquals(-600f, zoom.panX, 1e-3f)
        zoom.adoptImage(photo, NativeImageSize(3200, 3000), CropRect(right = 0.8f), 4000, 3000,
            1000f, 750f)
        assertEquals(1f, zoom.pixelScale)
        assertEquals("source column 2600 stays centred", -1000f, zoom.panX, 1e-3f)
        zoom.adoptImage(photo, NativeImageSize(4000, 3000), CropRect(), 4000, 3000, 1000f, 750f)
        assertEquals(1f, zoom.pixelScale)
        assertEquals(-600f, zoom.panX, 1e-3f)
    }

    @Test
    fun aNewCanvasForAFoldPostureKeepsTheZoom() {
        val zoom = atActualSize()
        zoom.enterScope(CanvasZoomScope(photo, PhotoMode.Edit, cropTool = false))
        assertTrue(zoom.isZoomed)
        assertEquals(-600f, zoom.panX, 1e-3f)
    }

    @Test
    fun aPinchLeftLiveByACancelledGestureEndsAtTheNextTouch() {
        val zoom = CanvasZoomState()
        zoom.pinchChanged(1f, 500f, 375f, 4000, 3000, 1000f, 750f)
        zoom.pinchChanged(3f, 500f, 375f, 4000, 3000, 1000f, 750f)
        val pinched = zoom.pixelScale
        compose.setContent {
            Box(Modifier.size(300.dp).testTag("settle-box").pointerInput(Unit) {
                detectCanvasZoomPanAndSwipe(zoom, { 4000 to 3000 }, false, {})
            })
        }
        compose.onNodeWithTag("settle-box").performTouchInput { click(center) }
        compose.runOnIdle {
            zoom.pinchChanged(1f, 100f, 100f, 4000, 3000, 1000f, 750f)
            zoom.pinchChanged(1f, 100f, 100f, 4000, 3000, 1000f, 750f)
            assertEquals("a new pinch starts from the settled zoom", pinched, zoom.pixelScale, 1e-6f)
        }
    }
}
