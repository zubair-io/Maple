package app.justmaple.aperture.ui

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
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
    fun zoomBadgeNamesItsNextStopAndReportsTheZoomAsState() {
        var clicks = 0
        compose.setContent {
            CanvasZoomBadge(
                label = "100%",
                isZoomed = true,
                actionDescription = "Zoom to Fit",
                enabled = true,
                onClick = { clicks++ },
            )
        }
        val node = compose.onNodeWithTag("canvas-zoom-indicator")
        node.assertIsDisplayed()
        val config = node.fetchSemanticsNode().config
        assertEquals("100%", config[SemanticsProperties.StateDescription])
        assertEquals(listOf("Zoom to Fit"), config[SemanticsProperties.ContentDescription])
        node.performClick()
        compose.runOnIdle { assertEquals(1, clicks) }
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
