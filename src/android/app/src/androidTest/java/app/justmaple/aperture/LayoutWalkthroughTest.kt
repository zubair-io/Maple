package app.justmaple.aperture

import android.content.ContentValues
import android.net.Uri
import android.provider.MediaStore
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
        capture("01-library")
        compose.onNodeWithContentDescription(source.name).performClick()
        compose.onNodeWithText("Edit", useUnmergedTree = true).assertIsDisplayed()
        val window = compose.onRoot().fetchSemanticsNode().boundsInRoot
        val edit =
            compose.onNodeWithText("Edit", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
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
        capture("02-preview")
        compose.onNodeWithText("Edit", useUnmergedTree = true).performClick()
        compose.waitUntil(60_000) {
            model.state.value.mode == PhotoMode.Edit &&
                model.state.value.values.isNotEmpty() &&
                !model.state.value.rendering
        }
        assertNull(model.state.value.error)
        compose.onNodeWithContentDescription("Photo canvas").assertIsDisplayed()
        capture("03-edit")
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
        compose.onNodeWithContentDescription("Undo").performClick()
        assertEquals(0f, model.state.value.values.getValue("exposure"))
        compose.onNodeWithContentDescription("Back").performClick()
        compose.onNodeWithText("Edit", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithContentDescription("Back").performClick()
        compose.onNodeWithContentDescription("Settings").performClick()
        compose.onNodeWithText("Show filmstrip").assertIsDisplayed()
        capture("04-settings")
        assertFalse(model.state.value.dirty)
    }

    private fun capture(name: String) {
        compose.waitForIdle()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val size = context.resources.configuration
        val display = "${size.screenWidthDp}x${size.screenHeightDp}"
        val values =
            ContentValues().apply {
                put(MediaStore.Downloads.DISPLAY_NAME, "$display-$name.png")
                put(MediaStore.Downloads.MIME_TYPE, "image/png")
                put(MediaStore.Downloads.RELATIVE_PATH, "Download/MapleWalkthrough")
                put(MediaStore.Downloads.IS_PENDING, 1)
            }
        val uri =
            context.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)!!
        val frame = instrumentation.uiAutomation.takeScreenshot()
        try {
            context.contentResolver.openOutputStream(uri)!!.use {
                assertTrue(frame.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it))
            }
            context.contentResolver.update(
                uri,
                ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) },
                null,
                null,
            )
        } finally {
            frame.recycle()
        }
    }
}
