package app.justmaple.aperture

import android.content.ContentValues
import android.graphics.Bitmap
import android.net.Uri
import android.provider.MediaStore
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.ViewModelProvider
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class EditorIntegrationTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Test
    fun committedRawFixtureRendersAndSurvivesActivityRecreation() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val original = File(instrumentation.targetContext.filesDir, "android-source.dng")
        instrumentation.context.assets.open("source.dng").use { input ->
            original.outputStream().use { input.copyTo(it) }
        }
        val initial = original.readBytes()
        val model = ViewModelProvider(compose.activity)[MapleViewModel::class.java]
        compose.runOnIdle { model.openSingle(Uri.fromFile(original)) }
        compose.waitUntil(30_000) {
            model.state.value.selected != null && !model.state.value.loading
        }
        compose.onNodeWithContentDescription("Edit").performClick()
        compose.waitUntil(120_000) {
            !model.state.value.rendering && model.state.value.mode == PhotoMode.Edit
        }
        assertNull(model.state.value.error)
        assertTrue(model.state.value.values.getValue("_aspect") > 0f)
        compose.waitForIdle()
        captureEditorFrame()
        compose.runOnIdle {
            model.setField("exposure", .75f)
            model.commitGesture()
            model.setField("tint", 20f)
            model.commitGesture()
        }
        compose.activityRule.scenario.recreate()
        compose.waitUntil(30_000) { !model.state.value.dirty && !model.state.value.saving }
        val recreated = ViewModelProvider(compose.activity)[MapleViewModel::class.java]
        assertSame(model, recreated)
        assertEquals(.75f, recreated.state.value.values.getValue("exposure"), .001f)
        assertNull(recreated.state.value.error)
        val saved = runBlocking { model.library.loadSidecar(model.state.value.selected!!) }
        assertEquals("0.75", saved.document.attribute("crs:Exposure2012"))
        assertEquals("20", saved.document.attribute("crs:Tint"))
        assertNotNull(saved.document.attribute("crs:Temperature"))
        assertArrayEquals(initial, original.readBytes())
        original.delete()
    }

    private fun captureEditorFrame() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val canvas =
            compose.onNodeWithContentDescription("Photo canvas").fetchSemanticsNode().boundsInRoot
        // The committed fixture is grey. Wait for a visible buffer rather than
        // capturing the SurfaceView's initial black buffer; colour parity is
        // tested separately against the Rust CPU reference.
        compose.waitUntil(30_000) {
            val pixel = renderedPixel(compose.activity)
            android.graphics.Color.red(pixel) > 80 &&
                android.graphics.Color.green(pixel) > 80 &&
                android.graphics.Color.blue(pixel) > 80
        }

        val kind =
            if (context.resources.configuration.smallestScreenWidthDp >= 600) "tablet" else "phone"
        val values =
            ContentValues().apply {
                put(
                    MediaStore.Downloads.DISPLAY_NAME,
                    "maple-$kind-editor-${System.nanoTime()}.png",
                )
                put(MediaStore.Downloads.MIME_TYPE, "image/png")
                put(MediaStore.Downloads.RELATIVE_PATH, "Download/MapleVerification")
                put(MediaStore.Downloads.IS_PENDING, 1)
            }
        val uri =
            context.contentResolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)!!
        val screenshot = instrumentation.uiAutomation.takeScreenshot()
        try {
            context.contentResolver.openOutputStream(uri)!!.use { output ->
                check(screenshot.compress(Bitmap.CompressFormat.PNG, 100, output))
            }
            context.contentResolver.update(
                uri,
                ContentValues().apply { put(MediaStore.Downloads.IS_PENDING, 0) },
                null,
                null,
            )
        } finally {
            screenshot.recycle()
        }
    }

    @Test
    fun openDevelopSaveUndoAndExportKeepOriginalBytes() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val original = File(context.filesDir, "android-roundtrip.png")
        val bitmap = Bitmap.createBitmap(80, 60, Bitmap.Config.ARGB_8888)
        bitmap.eraseColor(android.graphics.Color.rgb(110, 135, 150))
        original.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
        val initial = original.readBytes()
        val model = ViewModelProvider(compose.activity)[MapleViewModel::class.java]
        compose.runOnIdle { model.openSingle(Uri.fromFile(original)) }
        compose.waitUntil(30_000) {
            model.state.value.selected != null && !model.state.value.loading
        }
        compose.runOnIdle {
            model.attribute("xmp:Label", "Sunset 🌅")
            model.attribute("xmp:Rating", "3")
            assertFalse(model.state.value.canUndo)
        }
        compose.onNodeWithContentDescription("Edit").performClick()
        compose.waitUntil(120_000) {
            model.state.value.mode == PhotoMode.Edit && !model.state.value.rendering
        }
        assertNull(model.state.value.error)
        assertTrue(model.state.value.values.isNotEmpty())
        compose.runOnIdle {
            assertTrue("Waited for an editable canvas", model.state.value.canEdit)
            model.undo()
            assertTrue(model.state.value.values.isNotEmpty())
            model.setField("exposure", 1.25f)
            assertEquals(1.25f, model.state.value.values.getValue("exposure"), .001f)
            model.commitGesture()
        }
        compose.waitUntil(30_000) { !model.state.value.dirty && !model.state.value.saving }
        val photo = model.state.value.selected!!
        val saved = runBlocking { model.library.loadSidecar(photo) }
        assertEquals("1.25", saved.document.attribute("crs:Exposure2012"))
        assertEquals("Sunset 🌅", saved.document.attribute("xmp:Label"))
        assertEquals("3", saved.document.attribute("xmp:Rating"))
        compose.runOnIdle { model.undo() }
        compose.waitUntil(30_000) { !model.state.value.dirty && !model.state.value.saving }
        val restored = runBlocking { model.library.loadSidecar(photo) }
        assertNull(restored.document.attribute("crs:Exposure2012"))
        val destination = File(context.filesDir, "android-export.jpg")
        runBlocking { model.export(Uri.fromFile(destination), false) }
        assertTrue(destination.length() > 0)
        try {
            runBlocking { model.export(Uri.fromFile(original), false) }
            fail("Export must reject the original URI")
        } catch (expected: IllegalStateException) {
            assertTrue(expected.message.orEmpty().contains("original", ignoreCase = true))
        }
        assertArrayEquals(initial, original.readBytes())
        destination.delete()
        original.delete()
    }
}
