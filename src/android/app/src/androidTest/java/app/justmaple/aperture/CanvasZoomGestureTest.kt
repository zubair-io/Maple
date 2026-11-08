package app.justmaple.aperture

import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.click
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeLeft
import androidx.compose.ui.test.swipeRight
import androidx.compose.ui.unit.dp
import app.justmaple.aperture.ui.CanvasZoomState
import app.justmaple.aperture.ui.detectCanvasZoomPanAndSwipe
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test

/** The Compose canvas driving the shared Rust zoom model through the real JNI binding (#5714). */
class CanvasZoomGestureTest {
    @get:Rule val compose = mainThreadComposeRule<ComponentActivity>()

    @Test
    fun pinchFrom100PercentBelowFitFollowsTheFingersAndReturnsToFitOnRelease() {
        val zoom = CanvasZoomState()
        zoom.advanceStop(800, 600, 1000f, 750f)
        assertEquals(1f, zoom.pixelScale, 0f)
        zoom.pinchChanged(1f, 500f, 375f, 800, 600, 1000f, 750f)
        zoom.pinchChanged(1.1f, 500f, 375f, 800, 600, 1000f, 750f)
        assertEquals(1.1f, zoom.pixelScale, 1e-6f)
        zoom.pinchChanged(0.9f, 500f, 375f, 800, 600, 1000f, 750f)
        assertEquals("a live pinch does not snap to fit", 0.9f, zoom.pixelScale, 1e-6f)
        zoom.pinchEnded(0.9f, 0L, 800, 600, 1000f, 750f)
        assertFalse("a release below fit returns to fit", zoom.isZoomed)
    }

    @Test
    fun aShortPinchWithSequentialFingerLiftsCannotSeedADoubleTap() {
        val zoom = CanvasZoomState()
        compose.setContent {
            Box(Modifier.size(300.dp).testTag("pinch-box").pointerInput(Unit) {
                detectCanvasZoomPanAndSwipe(zoom, { 1200 to 900 }, false, {})
            })
        }
        val box = compose.onNodeWithTag("pinch-box")
        box.performTouchInput {
            down(0, Offset(80f, 150f))
            down(1, Offset(220f, 150f))
            moveTo(1, Offset(240f, 150f))
            up(1)
            advanceEventTime(10)
            up(0)
        }
        val scale = compose.runOnIdle { assertTrue(zoom.isZoomed); zoom.pixelScale }
        box.performTouchInput { click(center) }
        compose.runOnIdle { assertEquals(scale, zoom.pixelScale, 1e-6f) }
    }

    @Test
    fun aSymmetricPinchWhoseSecondFingerLandsLaterDoesNotPan() {
        val zoom = CanvasZoomState()
        compose.setContent {
            Box(Modifier.size(300.dp).testTag("centroid-box").pointerInput(Unit) {
                detectCanvasZoomPanAndSwipe(zoom, { 4000 to 4000 }, false, {})
            })
        }
        compose.onNodeWithTag("centroid-box").performTouchInput {
            val y = centerY
            down(0, Offset(width * 0.3f, y))
            advanceEventTime(16)
            down(1, Offset(width * 0.7f, y))
            advanceEventTime(16)
            updatePointerTo(0, Offset(width * 0.2f, y))
            updatePointerTo(1, Offset(width * 0.8f, y))
            move()
            up(1)
            up(0)
        }
        compose.runOnIdle {
            assertTrue(zoom.isZoomed)
            assertEquals(0f, zoom.panX, 1f)
            assertEquals(0f, zoom.panY, 1f)
        }
    }

    @Test
    fun aFingerLandingOrLiftingMidPinchNeitherZoomsNorPans() {
        val zoom = CanvasZoomState()
        compose.setContent {
            Box(Modifier.size(300.dp).testTag("membership-box").pointerInput(Unit) {
                detectCanvasZoomPanAndSwipe(zoom, { 4000 to 4000 }, false, {})
            })
        }
        val box = compose.onNodeWithTag("membership-box")
        box.performTouchInput {
            down(0, Offset(width * 0.3f, centerY))
            advanceEventTime(16)
            down(1, Offset(width * 0.7f, centerY))
            advanceEventTime(16)
            updatePointerTo(0, Offset(width * 0.2f, centerY))
            updatePointerTo(1, Offset(width * 0.8f, centerY))
            move()
        }
        val (scale, panX, panY) = compose.runOnIdle { Triple(zoom.pixelScale, zoom.panX, zoom.panY) }
        box.performTouchInput {
            advanceEventTime(16)
            down(2, Offset(width * 0.9f, centerY))
            advanceEventTime(16)
            move()
        }
        compose.runOnIdle {
            assertEquals("a third finger landing", scale, zoom.pixelScale, 1e-6f)
            assertEquals(panX, zoom.panX, 1f)
            assertEquals(panY, zoom.panY, 1f)
        }
        box.performTouchInput {
            advanceEventTime(16)
            up(0)
            advanceEventTime(16)
            move()
        }
        compose.runOnIdle {
            assertEquals("one of three fingers lifting", scale, zoom.pixelScale, 1e-6f)
            assertEquals(panX, zoom.panX, 1f)
            assertEquals(panY, zoom.panY, 1f)
        }
        box.performTouchInput {
            advanceEventTime(16)
            up(1)
            advanceEventTime(16)
            moveBy(2, Offset(-30f, 0f))
            up(2)
        }
        compose.runOnIdle {
            assertEquals("the last finger hands off to a pan", scale, zoom.pixelScale, 1e-6f)
            assertTrue("pan ${zoom.panX} stays within the hand-off move", zoom.panX in panX - 31f..panX + 1f)
            assertEquals(panY, zoom.panY, 1f)
        }
    }

    /** Codex on #5722: after a third finger lands, the pinch pivots on all three fingers' centroid. */
    @Test
    fun aPinchAfterAThirdFingerLandsPivotsOnTheThreeFingerCentroid() {
        val zoom = CanvasZoomState()
        compose.setContent {
            Box(Modifier.size(300.dp).testTag("pivot-box").pointerInput(Unit) {
                detectCanvasZoomPanAndSwipe(zoom, { 4000 to 4000 }, false, {})
            })
        }
        var width = 0f
        compose.onNodeWithTag("pivot-box").performTouchInput {
            width = this.width.toFloat()
            down(0, Offset(width * 0.3f, centerY))
            advanceEventTime(16)
            down(1, Offset(width * 0.7f, centerY))
            advanceEventTime(16)
            down(2, Offset(width * 0.8f, centerY))
            advanceEventTime(16)
            updatePointerTo(0, Offset(width * 0.15f, centerY))
            updatePointerTo(1, Offset(width * 0.75f, centerY))
            updatePointerTo(2, Offset(width * 0.9f, centerY))
            move()
            up(0)
            up(1)
            up(2)
        }
        compose.runOnIdle {
            assertTrue(zoom.isZoomed)
            assertEquals("the image point under x = 0.6w stays put", -0.05f * width, zoom.panX, 1f)
            assertEquals(0f, zoom.panY, 1f)
        }
    }

    @Test
    fun aResetMidPinchHoldsFitUntilTheFingersMoveAgain() {
        val zoom = CanvasZoomState()
        compose.setContent {
            Box(Modifier.size(300.dp).testTag("reset-box").pointerInput(Unit) {
                detectCanvasZoomPanAndSwipe(zoom, { 4000 to 4000 }, false, {})
            })
        }
        val box = compose.onNodeWithTag("reset-box")
        var side = 0f
        box.performTouchInput {
            side = width.toFloat()
            down(0, Offset(width * 0.3f, centerY))
            advanceEventTime(16)
            down(1, Offset(width * 0.7f, centerY))
            advanceEventTime(16)
            updatePointerTo(0, Offset(width * 0.2f, centerY))
            updatePointerTo(1, Offset(width * 0.8f, centerY))
            move()
        }
        compose.runOnIdle {
            assertTrue(zoom.isZoomed)
            zoom.reset()
        }
        box.performTouchInput {
            advanceEventTime(16)
            updatePointerTo(0, Offset(width * 0.2f, centerY + 1f))
            updatePointerTo(1, Offset(width * 0.8f, centerY + 1f))
            move()
        }
        compose.runOnIdle { assertFalse("the same fingers hold fit after the reset", zoom.isZoomed) }
        box.performTouchInput {
            advanceEventTime(16)
            updatePointerTo(0, Offset(width * 0.1f, centerY + 1f))
            updatePointerTo(1, Offset(width * 0.9f, centerY + 1f))
            move()
            up(0)
            up(1)
        }
        compose.runOnIdle {
            val fit = zoom.fitScale(4000, 4000, side, side)
            assertEquals("spreading 0.6w → 0.8w zooms 4/3 from fit", fit * 4f / 3f,
                zoom.effectiveScale(4000, 4000, side, side), fit * 0.01f)
        }
    }

    @Test
    fun doubleTapZoomsInToTheCapWhenFitAlreadyEnlargesTheImage() {
        val zoom = CanvasZoomState()
        zoom.doubleTap(600f, 450f, 1000, 750, 1200f, 900f)
        assertEquals("100% would shrink an image that fits at 120%", 8f, zoom.pixelScale, 0f)
        assertEquals(8f / 1.2f, zoom.zoomFactorOverFit(1000, 750, 1200f, 900f), 1e-5f)
        assertEquals("800%", zoom.badgeLabel(1000, 750, 1200f, 900f))
        zoom.doubleTap(600f, 450f, 1000, 750, 1200f, 900f)
        assertFalse(zoom.isZoomed)
    }

    @Test
    fun fitScaleAndDoubleTapToggleOneToOnePixels() {
        val zoom = CanvasZoomState()
        assertEquals(0.25f, zoom.fitScale(4000, 3000, 1000f, 750f), 1e-4f)
        assertFalse(zoom.isZoomed)
        assertEquals("25%", zoom.badgeLabel(4000, 3000, 1000f, 750f))

        zoom.doubleTap(750f, 375f, 4000, 3000, 1000f, 750f)
        assertTrue(zoom.isZoomed)
        assertEquals(1.0f, zoom.pixelScale, 1e-4f)
        assertEquals("100%", zoom.badgeLabel(4000, 3000, 1000f, 750f))
        assertEquals(4.0f, zoom.zoomFactorOverFit(4000, 3000, 1000f, 750f), 1e-4f)
        assertTrue("Tap right of center shifts pan left", zoom.panX < 0f)

        zoom.doubleTap(500f, 375f, 4000, 3000, 1000f, 750f)
        assertFalse(zoom.isZoomed)
        assertEquals(0f, zoom.panX, 1e-4f)
        assertEquals(0f, zoom.panY, 1e-4f)
    }

    @Test
    fun pinchSettlesOnFitInsideItsBandAndClampsAtMaxScale() {
        val zoom = CanvasZoomState()
        zoom.pinchChanged(1f, 500f, 250f, 2000, 1000, 1000f, 500f)
        zoom.pinchChanged(2.0f, 500f, 250f, 2000, 1000, 1000f, 500f)
        zoom.pinchEnded(2.0f, 0L, 2000, 1000, 1000f, 500f)
        assertEquals(1.0f, zoom.pixelScale, 1e-4f)

        zoom.pinchChanged(1f, 500f, 250f, 2000, 1000, 1000f, 500f)
        zoom.pinchChanged(0.515f, 500f, 250f, 2000, 1000, 1000f, 500f)
        zoom.pinchEnded(0.515f, 0L, 2000, 1000, 1000f, 500f)
        assertFalse("Within 4% of fit settles on fit", zoom.isZoomed)

        zoom.pinchChanged(1f, 500f, 250f, 2000, 1000, 1000f, 500f)
        zoom.pinchChanged(30f, 500f, 250f, 2000, 1000, 1000f, 500f)
        assertEquals(8f, zoom.pixelScale, 1e-4f)
        zoom.pinchEnded(30f, 0L, 2000, 1000, 1000f, 500f)

        zoom.reset()
        zoom.pinchChanged(1f, 500f, 250f, 2000, 1000, 1000f, 500f)
        zoom.pinchChanged(0.1f, 500f, 250f, 2000, 1000, 1000f, 500f)
        assertEquals("Zoom out stops at half of fit", 0.25f, zoom.pixelScale, 1e-4f)
        zoom.pinchEnded(0.1f, 0L, 2000, 1000, 1000f, 500f)
        assertFalse("A release below fit returns to fit", zoom.isZoomed)
    }

    @Test
    fun panIsInertAtFitRespectsPostPinchCooldownAndClampsToBounds() {
        val zoom = CanvasZoomState()
        assertFalse(zoom.dragChanged(50f, 40f, 2000, 1000, 1000f, 500f, nowMs = 1000L))
        assertEquals(0f, zoom.panX, 1e-4f)
        zoom.dragEnded()

        zoom.pinchChanged(1f, 500f, 250f, 2000, 1000, 1000f, 500f)
        zoom.pinchChanged(2.0f, 500f, 250f, 2000, 1000, 1000f, 500f)
        zoom.pinchEnded(2.0f, 1000L, 2000, 1000, 1000f, 500f)

        assertFalse(zoom.dragChanged(100f, 50f, 2000, 1000, 1000f, 500f, nowMs = 1150L))
        assertEquals(0f, zoom.panX, 1e-4f)

        // Movement during the cooldown is absorbed, so only the later 900 x -600 pans.
        assertTrue(zoom.dragChanged(1000f, -550f, 2000, 1000, 1000f, 500f, nowMs = 1350L))
        assertEquals(500f, zoom.panX, 1e-4f)
        assertEquals(-250f, zoom.panY, 1e-4f)
    }

    @Test
    fun badgeCyclesFitFillAnd100Percent() {
        val zoom = CanvasZoomState()
        assertEquals("Zoom to Fill", zoom.nextStopDescription(2000, 1000, 1000f, 750f))
        zoom.advanceStop(2000, 1000, 1000f, 750f)
        assertEquals(0.75f, zoom.pixelScale, 1e-6f)
        assertEquals("Zoom to 100%", zoom.nextStopDescription(2000, 1000, 1000f, 750f))
        zoom.advanceStop(2000, 1000, 1000f, 750f)
        assertEquals(1f, zoom.pixelScale, 0f)
        assertEquals("Zoom to Fit", zoom.nextStopDescription(2000, 1000, 1000f, 750f))
        zoom.advanceStop(2000, 1000, 1000f, 750f)
        assertFalse(zoom.isZoomed)
    }

    @Test
    fun fillFollowsAViewportResize() {
        val zoom = CanvasZoomState()
        zoom.advanceStop(2000, 1000, 1000f, 750f)
        zoom.reclamp(2000, 1000, 1000f, 1000f)
        assertEquals(1f, zoom.pixelScale, 1e-6f)
    }

    @Test
    fun delayedOriginalMetadataKeepsOneToOneDoubleTapAndItsAnchor() {
        val zoom = CanvasZoomState()
        zoom.doubleTap(750f, 375f, 2048, 1365, 1000f, 750f)
        zoom.adoptNativeDimensions(2048, 1365, 6000, 4000, 1000f, 750f)
        assertEquals(1f, zoom.pixelScale, 0f)
        assertEquals(-1250f, zoom.panX, .001f)
        assertEquals(4500f, (750f - 500f - zoom.panX) / zoom.pixelScale + 3000f, .001f)
    }

    @Test
    fun delayedOriginalMetadataKeepsPinchMagnificationRelativeToFit() {
        val zoom = CanvasZoomState()
        zoom.pinchChanged(1f, 750f, 375f, 2048, 1365, 1000f, 750f)
        zoom.pinchChanged(2f, 750f, 375f, 2048, 1365, 1000f, 750f)
        zoom.pinchEnded(2f, 0L, 2048, 1365, 1000f, 750f)
        zoom.adoptNativeDimensions(2048, 1365, 6000, 4000, 1000f, 750f)
        assertEquals(2f, zoom.zoomFactorOverFit(6000, 4000, 1000f, 750f), .001f)
        assertEquals(-250f, zoom.panX, .001f)
    }

    @Test
    fun previewSwipePagesAtFitButPansInsteadOfPagingWhenZoomed() {
        val zoom = CanvasZoomState()
        val pagedDeltas = mutableListOf<Int>()
        compose.setContent {
            Box(
                Modifier.size(300.dp, 300.dp)
                    .pointerInput(Unit) {
                        detectCanvasZoomPanAndSwipe(
                            zoomState = zoom,
                            imageDimensions = { 4000 to 3000 },
                            allowSwipePaging = true,
                            onSwipePage = { pagedDeltas += it },
                        )
                    }
                    .testTag("gesture-box")
            )
        }
        compose.onNodeWithTag("gesture-box").performTouchInput { swipeLeft() }
        compose.runOnIdle { assertEquals(listOf(1), pagedDeltas) }

        compose.onNodeWithTag("gesture-box").performTouchInput { swipeRight() }
        compose.runOnIdle { assertEquals(listOf(1, -1), pagedDeltas) }

        val box = compose.onNodeWithTag("gesture-box").fetchSemanticsNode().size
        val (width, height) = box.width.toFloat() to box.height.toFloat()
        compose.runOnIdle { zoom.doubleTap(width / 2f, height / 2f, 4000, 3000, width, height) }
        compose.onNodeWithTag("gesture-box").performTouchInput { swipeLeft() }
        compose.runOnIdle {
            assertEquals(listOf(1, -1), pagedDeltas)
            assertTrue(zoom.panX < 0f)
        }
    }
}
