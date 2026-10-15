package app.justmaple.aperture

import android.net.Uri
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.ViewModelProvider
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class LayoutWalkthroughTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Test
    fun libraryPreviewEditorAndSettingsRemainReachable() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val source = File(context.filesDir, "layout-gradient.png")
        instrumentation.context.assets.open("rgb-gradient.png").use { input ->
            source.outputStream().use { input.copyTo(it) }
        }
        val model = ViewModelProvider(compose.activity)[MapleViewModel::class.java]
        compose.runOnIdle { model.openSingle(Uri.fromFile(source)) }
        compose.waitUntil(30_000) {
            model.state.value.selected != null && !model.state.value.loading
        }
        compose.runOnIdle { model.back() }
        compose.waitUntil(10_000) { model.state.value.mode == PhotoMode.Browse }
        compose.waitUntil(30_000) {
            compose.onAllNodesWithContentDescription(source.name).fetchSemanticsNodes().isNotEmpty()
        }
        compose.captureWalkthrough("01-library")
        compose.onNodeWithContentDescription(source.name).performClick()
        compose.onNodeWithContentDescription("Edit").assertIsDisplayed()
        val window = compose.onRoot().fetchSemanticsNode().boundsInRoot
        val edit = compose.onNodeWithContentDescription("Edit").fetchSemanticsNode().boundsInRoot
        for (rating in 1..5) {
            val button =
                compose
                    .onNodeWithContentDescription("Rate $rating stars")
                    .fetchSemanticsNode()
                    .boundsInRoot
            assertTrue(
                "Rating button must remain inside the window",
                window.contains(button.topLeft) && button.right <= window.right,
            )
            assertFalse("Edit and rating actions must not overlap", button.overlaps(edit))
        }
        compose.runOnIdle { model.attribute("xmp:Rating", "3.0") }
        compose.onNodeWithContentDescription("Rate 3 stars").assertIsSelected()
        compose.onNodeWithContentDescription("Rate 4 stars").assertIsNotSelected()
        compose.onNodeWithContentDescription("Rate 3 stars").performClick()
        compose.onNodeWithContentDescription("Rate 3 stars").assertIsNotSelected()
        compose.captureWalkthrough("02-preview")
        compose.onNodeWithContentDescription("Edit").performClick()
        compose.waitUntil(60_000) {
            model.state.value.mode == PhotoMode.Edit &&
                model.state.value.values.isNotEmpty() &&
                !model.state.value.rendering
        }
        assertNull(model.state.value.error)
        compose.onNodeWithContentDescription("Photo canvas").assertIsDisplayed()
        compose.waitUntil(30_000) {
            compose
                .onNodeWithContentDescription("RGB histogram")
                .fetchSemanticsNode()
                .config[SemanticsProperties.StateDescription] == "Ready"
        }
        compose.captureWalkthrough("03-edit")
        if (context.resources.configuration.smallestScreenWidthDp >= 600) {
            val header = compose.onNodeWithTag("photo-header").fetchSemanticsNode().boundsInRoot
            val panel = compose.onNodeWithTag("adjustments-panel").fetchSemanticsNode().boundsInRoot
            assertTrue("Floating inspector must clear the header", panel.top >= header.bottom)
            compose.onNodeWithContentDescription("Collapse filmstrip").performClick()
            compose.onNodeWithContentDescription("Expand filmstrip").performClick()
            compose.onNodeWithContentDescription("More photo actions").performClick()
            compose.onNodeWithText("Hide adjustments").performClick()
            compose.onNodeWithTag("adjustments-panel").assertDoesNotExist()
            compose.onNodeWithContentDescription("More photo actions").performClick()
            compose.onNodeWithText("Show adjustments").performClick()
            compose.onNodeWithTag("adjustments-panel").assertIsDisplayed()
        }
        compose.waitForIdle()
        compose.waitUntil(30_000) { !model.state.value.rendering }
        val sliderLabel =
            if (context.resources.configuration.smallestScreenWidthDp >= 600) "Exposure adjustment"
            else "Exposure"
        compose
            .onNode(
                hasContentDescription(sliderLabel) and
                    SemanticsMatcher.keyIsDefined(SemanticsProperties.ProgressBarRangeInfo)
            )
            .performSemanticsAction(SemanticsActions.SetProgress) {
                it(.25f)
            }
        assertEquals(.25f, model.state.value.values.getValue("exposure"))
        if (context.resources.configuration.smallestScreenWidthDp >= 600) {
            compose.onNodeWithText("Reset Light").performClick()
            assertEquals(0f, model.state.value.values.getValue("exposure"))
            compose.onNodeWithContentDescription("Undo").performClick()
            assertEquals(.25f, model.state.value.values.getValue("exposure"))
        }
        compose.onNodeWithContentDescription("Undo").performClick()
        assertEquals(0f, model.state.value.values.getValue("exposure"))
        compose.onNodeWithContentDescription("Back").performClick()
        compose.onNodeWithContentDescription("Edit").assertIsDisplayed()
        compose.onNodeWithContentDescription("Back").performClick()
        compose.onNodeWithContentDescription("Settings").performClick()
        compose.onNodeWithText("Cloud").assertIsDisplayed()
        compose.captureWalkthrough("04-settings")
        compose.onNode(hasText("General") and hasClickAction()).performClick()
        compose.onNodeWithText("Show filmstrip").assertIsDisplayed()
        compose.onNodeWithContentDescription("Back to Settings").performClick()
        compose.onNodeWithText("Cloud").performClick()
        compose
            .onNode(
                hasText("Add Maple Cloud server") and hasAnyAncestor(hasTestTag("settings-sheet"))
            )
            .assertIsDisplayed()
        compose.captureWalkthrough("05-settings-cloud")
        compose.onNodeWithContentDescription("Close Settings").performClick()
        compose.onNodeWithTag("settings-sheet").assertDoesNotExist()
        assertFalse(model.state.value.dirty)
    }
}
