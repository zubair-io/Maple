package app.justmaple.aperture.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.click
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipeLeft
import androidx.compose.ui.test.swipeRight
import androidx.compose.ui.unit.dp
import app.justmaple.aperture.MapleState
import app.justmaple.aperture.data.XmpDocument
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class CanvasZoomAndBeforeAfterTest {
    @get:Rule val compose = createComposeRule()

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
    fun doubleTapSelects100PercentEvenWhenFitAlreadyEnlargesTheImage() {
        val zoom = CanvasZoomState()
        zoom.doubleTap(600f, 450f, 1000, 750, 1200f, 900f)
        assertEquals(1f, zoom.pixelScale, 0f)
        assertEquals(1f / 1.2f, zoom.zoomFactorOverFit(1000, 750, 1200f, 900f), 1e-6f)
        assertEquals("100%", zoom.badgeLabel(1000, 750, 1200f, 900f))
        zoom.doubleTap(600f, 450f, 1000, 750, 1200f, 900f)
        assertFalse(zoom.isZoomed)
    }

    @Test
    fun holdingBeforeRestoresItsExistingLatchAfterReleaseAndCancellation() {
        var comparing by mutableStateOf(true)
        compose.setContent {
            CompareBeforeAfterButton(true, comparing, { comparing = it }, Modifier.testTag("compare-latched"))
        }
        val button = compose.onNodeWithTag("compare-latched")
        for (cancelled in listOf(false, true)) {
            button.performTouchInput { down(Offset(20f, 20f)); advanceEventTime(350L) }
            compose.mainClock.advanceTimeBy(350L)
            button.performTouchInput { if (cancelled) cancel() else up() }
            compose.runOnIdle { assertTrue("A hold must retain the previous latch", comparing) }
        }
    }

    @Test
    fun fitScaleAndDoubleTapToggleOneToOnePixels() {
        val zoom = CanvasZoomState()
        // 4000x3000 image in a 1000x750 viewport -> fitScale = 0.25 (25%)
        assertEquals(0.25f, zoom.fitScale(4000, 3000, 1000f, 750f), 1e-4f)
        assertFalse(zoom.isZoomed)
        assertEquals("25%", zoom.badgeLabel(4000, 3000, 1000f, 750f))

        // Double tap at (750, 375) zooms to 100% (1.0f) anchored at tap point
        zoom.doubleTap(750f, 375f, 4000, 3000, 1000f, 750f)
        assertTrue(zoom.isZoomed)
        assertEquals(1.0f, zoom.pixelScale, 1e-4f)
        assertEquals("100%", zoom.badgeLabel(4000, 3000, 1000f, 750f))
        assertEquals(4.0f, zoom.zoomFactorOverFit(4000, 3000, 1000f, 750f), 1e-4f)
        assertTrue("Tap right of center shifts pan left", zoom.panX < 0f)

        // Second double tap returns to Fit and zeroes pan
        zoom.doubleTap(500f, 375f, 4000, 3000, 1000f, 750f)
        assertFalse(zoom.isZoomed)
        assertEquals(0f, zoom.pixelScale, 1e-4f)
        assertEquals(0f, zoom.panX, 1e-4f)
        assertEquals(0f, zoom.panY, 1e-4f)
    }

    @Test
    fun pinchSnapsToFitNearFitThresholdAndClampsAtMaxScale() {
        val zoom = CanvasZoomState()
        // fitScale = 0.5 (2000x1000 in 1000x500)
        zoom.applyPinch(2.0f, 500f, 250f, 2000, 1000, 1000f, 500f)
        assertTrue(zoom.isZoomed)
        assertEquals(1.0f, zoom.pixelScale, 1e-4f)

        // Pinch down to 0.505 (<= 0.5 * 1.02 = 0.51) snaps back to Fit (0f)
        zoom.applyPinch(0.505f, 500f, 250f, 2000, 1000, 1000f, 500f)
        assertFalse(zoom.isZoomed)
        assertEquals(0f, zoom.pixelScale, 1e-4f)

        // Pinch beyond 800% clamps at MAX_PIXEL_SCALE (8.0f)
        zoom.applyPinch(30f, 500f, 250f, 2000, 1000, 1000f, 500f)
        assertEquals(CanvasZoomState.MAX_PIXEL_SCALE, zoom.pixelScale, 1e-4f)
    }

    @Test
    fun panIsInertAtFitRespectsPostPinchCooldownAndClampsToBounds() {
        val zoom = CanvasZoomState()
        assertFalse(zoom.applyPan(50f, 40f, 2000, 1000, 1000f, 500f, nowMs = 1000L))
        assertEquals(0f, zoom.panX, 1e-4f)

        zoom.applyPinch(2.0f, 500f, 250f, 2000, 1000, 1000f, 500f)
        zoom.endPinch(nowMs = 1000L)

        // Within 300ms post-pinch cooldown, single-finger pan is suppressed
        assertFalse(zoom.applyPan(100f, 50f, 2000, 1000, 1000f, 500f, nowMs = 1150L))
        assertEquals(0f, zoom.panX, 1e-4f)

        // After 300ms cooldown expires, pan engages and clamps to scaled bounds (maxPanX = 500, maxPanY = 250)
        assertTrue(zoom.applyPan(900f, -600f, 2000, 1000, 1000f, 500f, nowMs = 1350L))
        assertEquals(500f, zoom.panX, 1e-4f)
        assertEquals(-250f, zoom.panY, 1e-4f)
    }

    @Test
    fun zoomBadgeDisplaysPercentageAndResetsOnClickWhenZoomed() {
        val zoom = CanvasZoomState(initialPixelScale = 1.0f, initialPanX = 40f, initialPanY = -20f)
        compose.setContent {
            CanvasZoomBadge(
                label = zoom.badgeLabel(2000, 1000, 1000f, 500f),
                isZoomed = zoom.isZoomed,
                onReset = zoom::reset,
            )
        }
        val node = compose.onNodeWithTag("canvas-zoom-indicator")
        node.assertIsDisplayed()
        assertEquals(
            "100%",
            node.fetchSemanticsNode().config[SemanticsProperties.StateDescription],
        )
        node.performClick()
        compose.runOnIdle {
            assertFalse(zoom.isZoomed)
            assertEquals(0f, zoom.panX, 1e-4f)
        }
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
                            imageDimensions = { 1200 to 900 },
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

        // When zoomed in, swipe pans the image and does not trigger paging
        compose.runOnIdle { zoom.doubleTap(150f, 150f, 1200, 900, 300f, 300f) }
        compose.onNodeWithTag("gesture-box").performTouchInput { swipeLeft() }
        compose.runOnIdle {
            assertEquals(listOf(1, -1), pagedDeltas)
            assertTrue(zoom.panX < 0f)
        }
    }

    @Test
    fun beforeAfterButtonSupportsShortTapLatchAndHoldPeek() {
        var comparing by mutableStateOf(false)
        var enabled by mutableStateOf(false)
        compose.setContent {
            CompareBeforeAfterButton(
                enabled = enabled,
                comparingBefore = comparing,
                onSetComparingBefore = { comparing = it },
            )
        }
        val button = compose.onNodeWithTag("before-after-button")
        button.assertIsNotEnabled()

        compose.runOnIdle { enabled = true }
        button.assertIsEnabled()

        // Short tap (<300ms) latches Before on
        button.performTouchInput { click(Offset(20f, 20f)) }
        compose.runOnIdle { assertTrue(comparing) }
        button.assertIsSelected()

        // Second short tap unlatches Before
        button.performTouchInput { click(Offset(20f, 20f)) }
        compose.runOnIdle { assertFalse(comparing) }

        // Press and hold (>=300ms) peeks Before while held and restores After on release
        button.performTouchInput {
            down(Offset(20f, 20f))
            advanceEventTime(350L)
        }
        compose.mainClock.advanceTimeBy(350L)
        compose.runOnIdle { assertTrue("Hold should peek Before", comparing) }

        button.performTouchInput { up() }
        compose.runOnIdle { assertFalse("Release after hold should restore After", comparing) }
    }

    @Test
    fun hasActiveEditsRespectsShotWhiteBalanceAndAttributeEdits() {
        val uneditedRaw =
            MapleState(
                values =
                    mapOf(
                        "exposure" to 0f,
                        "temperature" to 4850f,
                        "_shot_temperature" to 4850f,
                        "tint" to 12f,
                        "_shot_tint" to 12f,
                    ),
                document = XmpDocument(),
            )
        assertFalse("Unedited RAW at shot WB should not report active edits", uneditedRaw.hasActiveEdits)

        val editedWb = uneditedRaw.copy(values = uneditedRaw.values + ("temperature" to 5500f))
        assertTrue("Manual WB away from shot WB should report active edits", editedWb.hasActiveEdits)

        val monochromeOnly =
            uneditedRaw.copy(document = XmpDocument().withAttribute("crs:ConvertToGrayscale", "True"))
        assertTrue("B&W toggle should report active edits", monochromeOnly.hasActiveEdits)

        val croppedOnly =
            uneditedRaw.copy(document = XmpDocument().withAttribute("crs:HasCrop", "True"))
        assertTrue("Crop should report active edits", croppedOnly.hasActiveEdits)
    }
}
