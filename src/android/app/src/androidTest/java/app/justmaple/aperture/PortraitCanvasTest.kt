package app.justmaple.aperture

import android.net.Uri
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.ViewModelProvider
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class PortraitCanvasTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Test
    fun portraitRawStaysInsideTheCanvasWhenAnErrorChangesTheAvailableHeight() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        // Optional on-device corpus fixture for visual diagnosis; the committed
        // oriented DNG keeps the regression reproducible without private RAWs.
        val corpusName = InstrumentationRegistry.getArguments().getString("portraitFixture")
        val original =
            if (corpusName != null) {
                require(corpusName == File(corpusName).name)
                File(context.filesDir, corpusName).also { check(it.isFile) }
            } else
                File(context.filesDir, "portrait-bounds.dng").also { file ->
                    instrumentation.context.assets.open("portrait.dng").use { input ->
                        file.outputStream().use { input.copyTo(it) }
                    }
                }
        val bytes = original.readBytes()
        val model = ViewModelProvider(compose.activity)[MapleViewModel::class.java]
        compose.runOnIdle { model.openSingle(Uri.fromFile(original)) }
        compose.waitUntil(30_000) {
            !model.state.value.loading && model.state.value.selected != null
        }
        compose.onNodeWithText("Edit", useUnmergedTree = true).performClick()
        compose.waitUntil(60_000) {
            model.state.value.values.isNotEmpty() && !model.state.value.rendering
        }
        assertNull(model.state.value.error)
        assertTrue(
            "EXIF orientation must produce a portrait canvas",
            model.state.value.values.getValue("_aspect") < 1,
        )
        assertInsideViewport()
        capture(model, "portrait-edit.png")
        compose.runOnIdle { model.report(UnsupportedOperationException()) }
        compose
            .onNodeWithText("Operation failed: UnsupportedOperationException")
            .assertIsDisplayed()
        assertInsideViewport()
        capture(model, "portrait-error-banner.png")
        compose.onNodeWithText("Dismiss").performClick()
        assertInsideViewport()
        assertArrayEquals(bytes, original.readBytes())
    }

    private fun assertInsideViewport() {
        compose.waitForIdle()
        val viewport = compose.onNodeWithTag("photo-viewport").getUnclippedBoundsInRoot()
        val canvas = compose.onNodeWithContentDescription("Photo canvas").getUnclippedBoundsInRoot()
        assertTrue(
            "Canvas $canvas must fit viewport $viewport",
            canvas.top >= viewport.top &&
                canvas.bottom <= viewport.bottom &&
                canvas.left >= viewport.left &&
                canvas.right <= viewport.right,
        )
    }

    private fun capture(model: MapleViewModel, name: String) {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        compose.waitForIdle()
        compose.waitUntil(30_000) { !model.state.value.rendering }
        val canvas =
            compose.onNodeWithContentDescription("Photo canvas").fetchSemanticsNode().boundsInRoot
        // Publishing the oriented aspect can replace the first, landscape-shaped
        // buffer. Wait for the replacement frame to reach the screen.
        compose.waitUntil(30_000) {
            val frame = instrumentation.uiAutomation.takeScreenshot()
            try {
                val pixel =
                    frame.getPixel(
                        canvas.center.x.toInt(),
                        (canvas.top + canvas.height * .3f).toInt(),
                    )
                android.graphics.Color.green(pixel) > 30 && android.graphics.Color.blue(pixel) > 30
            } finally {
                frame.recycle()
            }
        }
        val frame = instrumentation.uiAutomation.takeScreenshot()
        try {
            File(instrumentation.targetContext.getExternalFilesDir(null), name).outputStream().use {
                assertTrue(frame.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it))
            }
        } finally {
            frame.recycle()
        }
    }
}
