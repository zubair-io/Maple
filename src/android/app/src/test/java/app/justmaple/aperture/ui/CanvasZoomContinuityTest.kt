package app.justmaple.aperture.ui

import androidx.compose.runtime.saveable.SaverScope
import app.justmaple.aperture.PhotoMode
import app.justmaple.aperture.data.NativeImageSize
import app.justmaple.aperture.generated.CanvasZoomAbi.OP_ADOPT_IMAGE
import app.justmaple.aperture.generated.CanvasZoomAbi.OP_REFRAME_IMAGE
import app.justmaple.aperture.generated.CanvasZoomAbi.OP_SETTLE
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The zoom carries across rotation, a fold posture change and a crop undo (#5748): what the
 * Compose state keeps and which transition it sends. The transitions' math is pinned by the Rust
 * tests in `src/android/native/src/canvas_zoom_reframe_tests.rs`.
 */
class CanvasZoomContinuityTest {
    private val native = RecordingCanvasZoom()
    private val photo = "content://photos/a.dng:100:1"
    private val edit = CanvasZoomScope(photo, PhotoMode.Edit, cropTool = false)
    private val full = NativeImageSize(4000, 3000)

    private fun zoomedAtActualSize(): CanvasZoomState =
        CanvasZoomState(native).apply {
            enterScope(edit)
            adoptImage(photo, full, CropRect(), 2048, 1536, 1000f, 750f)
            doubleTap(500f, 375f, full.width, full.height, 1000f, 750f)
        }

    private fun saveAndRestore(zoom: CanvasZoomState): CanvasZoomState {
        val saver = canvasZoomSaver(native)
        val saved = with(saver) { SaverScope { true }.save(zoom) }!!
        return saver.restore(saved)!!
    }

    @Test fun recreatingTheActivityKeepsTheZoomAndPan() {
        val restored = saveAndRestore(zoomedAtActualSize())
        assertEquals(1f, restored.pixelScale)
        assertEquals(-120f, restored.panX)
        assertEquals(40f, restored.panY)
        restored.enterScope(edit.copy())
        assertTrue("the same photo and mode keep the zoom", restored.isZoomed)
        assertEquals(CanvasZoomFrame(photo, 4000, 3000, CropRect()), restored.frameFor(photo))
    }

    @Test fun aRestoredZoomDoesNotReadoptTheImage() {
        val restored = saveAndRestore(zoomedAtActualSize())
        native.calls.clear()
        restored.adoptImage(photo, full, CropRect(), 2048, 1536, 750f, 1000f)
        assertTrue(native.calls.isEmpty())
    }

    @Test fun anotherPhotoModeOrTheCropToolReturnsToFit() {
        for (next in listOf(edit.copy(photoKey = "other"), edit.copy(mode = PhotoMode.Preview),
            edit.copy(cropTool = true))) {
            val zoom = zoomedAtActualSize()
            zoom.enterScope(next)
            assertFalse("$next", zoom.isZoomed)
        }
    }

    @Test fun returningToAPhotoForgetsTheExtentAdoptedOnTheLastVisit() {
        val zoom = zoomedAtActualSize()
        zoom.enterScope(edit.copy(photoKey = "other"))
        zoom.enterScope(edit)
        assertNull(zoom.frameFor(photo))
        native.calls.clear()
        zoom.adoptImage(photo, NativeImageSize(3000, 3000), CropRect(left = 0.125f, right = 0.875f),
            2048, 2048, 1000f, 750f)
        assertEquals("the size is adopted afresh from the placeholder", OP_ADOPT_IMAGE,
            native.calls.single().op)
    }

    @Test fun aModeChangeKeepsTheAdoptedExtent() {
        val zoom = zoomedAtActualSize()
        zoom.enterScope(edit.copy(mode = PhotoMode.Preview))
        assertEquals(CanvasZoomFrame(photo, 4000, 3000, CropRect()), zoom.frameFor(photo))
    }

    @Test fun theFirstOriginalSizeIsAdoptedFromThePlaceholder() {
        CanvasZoomState(native).apply {
            enterScope(edit)
            adoptImage(photo, full, CropRect(), 2048, 1536, 1000f, 750f)
        }
        val call = native.calls.single()
        assertEquals(OP_ADOPT_IMAGE, call.op)
        assertEquals(2048.0, call.args[0], 0.0)
        assertEquals(1536.0, call.args[1], 0.0)
    }

    @Test fun aCropAndItsUndoReframeTheZoomInsteadOfResettingIt() {
        val zoom = zoomedAtActualSize()
        native.calls.clear()
        val cropped = CropRect(right = 0.8f)
        zoom.adoptImage(photo, NativeImageSize(3200, 3000), cropped, 2048, 1536, 1000f, 750f)
        zoom.adoptImage(photo, full, CropRect(), 2048, 1536, 1000f, 750f)
        assertEquals(listOf(OP_REFRAME_IMAGE, OP_REFRAME_IMAGE), native.calls.map { it.op })
        assertArrayEquals(doubleArrayOf(0.0, 0.0, 3200.0, 3000.0), native.calls[0].args, 1e-3)
        assertEquals(3200.0 to 3000.0, native.calls[0].image)
        assertArrayEquals(doubleArrayOf(0.0, 0.0, 4000.0, 3000.0), native.calls[1].args, 1e-3)
        assertEquals("no return to fit on the Compose side", 1f, zoom.pixelScale)
        assertEquals(CanvasZoomFrame(photo, 4000, 3000, CropRect()), zoom.frameFor(photo))
    }

    @Test fun theNewCropIsPlacedInThePreviousImagesPixels() {
        val previous = CanvasZoomFrame(photo, 2400, 1500, CropRect(top = 0.25f, left = 0.2f,
            bottom = 0.75f, right = 0.8f))
        val extent = previous.extentOf(CropRect(top = 0f, left = 0.4f, bottom = 1f, right = 0.9f))
        assertArrayEquals(doubleArrayOf(800.0, -750.0, 2000.0, 3000.0), extent, 1e-3)
    }

    @Test fun aDegenerateCropGivesAnExtentTheModelOnlyReclampsFor() {
        val previous = CanvasZoomFrame(photo, 2400, 1500, CropRect(left = 0.5f, right = 0.5f))
        assertTrue(previous.extentOf(CropRect()).any { it.isNaN() })
    }

    @Test fun settlingSendsTheSettleTransitionWithTheCurrentGeometry() {
        CanvasZoomState(native).settle(full.width, full.height, 1000f, 750f)
        val call = native.calls.single()
        assertEquals(OP_SETTLE, call.op)
        assertEquals(1000.0 to 750.0, call.viewport)
        assertEquals(4000.0 to 3000.0, call.image)
    }
}
