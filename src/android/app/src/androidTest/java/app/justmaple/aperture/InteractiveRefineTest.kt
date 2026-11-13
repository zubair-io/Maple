package app.justmaple.aperture

import android.graphics.Color
import android.net.Uri
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.ViewModelProvider
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class InteractiveRefineTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Test
    fun coalescedCpuControlsKeepGpuEditsUndoRedoAndSavedXmpCurrent() {
        val i = InstrumentationRegistry.getInstrumentation()
        val source = i.context.assets.open("source.dng").use { it.readBytes() }
        val original = File.createTempFile("interactive-refine-", ".dng", i.targetContext.filesDir)
        original.writeBytes(source)
        val model = ViewModelProvider(compose.activity)[MapleViewModel::class.java]
        try {
            compose.runOnIdle { model.openSingle(Uri.fromFile(original)) }
            compose.waitUntil(30_000) { model.state.value.canChangeMetadata }
            compose.onNodeWithContentDescription("Edit").performClick()
            compose.waitUntil(120_000) { model.state.value.canEdit }
            compose.waitForIdle()
            compose.waitUntil(30_000) { model.state.value.canEdit }
            fun redWhenReady() = runCatching {
                Color.red(renderedPixel(compose.activity))
            }
                .getOrNull()
            var baselineSample: Int? = null
            compose.waitUntil(30_000) {
                val pixel = redWhenReady()
                if (pixel != null && pixel > 10) {
                    baselineSample = pixel
                    true
                } else false
            }
            // Keep the successful sample; a second copy can race SurfaceView replacement.
            val baseline = checkNotNull(baselineSample)
            compose.runOnIdle {
                for (amount in 5..50 step 5) model.setField(
                    "capture_sharpening_amount",
                    amount.toFloat(),
                )
                model.setField("exposure", 1.5f)
                model.commitGesture()
            }
            compose.waitUntil(30_000) { redWhenReady()?.let { it > baseline + 15 } == true }
            compose.waitUntil(30_000) { !model.state.value.dirty && !model.state.value.saving }
            val saved = runBlocking {
                model.library.loadSidecar(model.state.value.selected!!)
            }
                .document
            assertEquals("50", saved.attribute("papp:CaptureSharpeningAmount"))
            assertEquals("1.5", saved.attribute("crs:Exposure2012"))
            compose.runOnIdle { model.undo() }
            compose.waitUntil(30_000) {
                redWhenReady()?.let { kotlin.math.abs(it - baseline) <= 2 } == true
            }
            compose.runOnIdle { model.redo() }
            compose.waitUntil(30_000) { redWhenReady()?.let { it > baseline + 15 } == true }
            assertEquals(50f, model.state.value.values.getValue("capture_sharpening_amount"), .001f)
            assertNull(model.state.value.error)
            assertArrayEquals(source, original.readBytes())
        } finally {
            runBlocking { model.flush() }
            original.delete()
        }
    }
}
