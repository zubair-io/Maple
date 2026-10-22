package app.justmaple.aperture

import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.ColorSpace
import android.net.Uri
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.ViewModelProvider
import androidx.test.platform.app.InstrumentationRegistry
import app.justmaple.aperture.data.NativeBridge
import app.justmaple.aperture.data.XmpDocument
import java.io.File
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class NativeDetailTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Test fun sourcePixelsReplaceTheEnlargedPreviewAtOneToOneInPreviewAndEdit() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val original = File.createTempFile("native-checker-", ".png", instrumentation.targetContext.filesDir)
        val pixels = IntArray(3072 * 2048) { index ->
            val x = index % 3072
            val y = index / 3072
            val white = 160 + ((x / 8 * 17 + y / 8 * 29) % 96)
            if ((x + y) % 2 == 0) Color.BLACK else Color.rgb(white, white, white)
        }
        val bitmap = Bitmap.createBitmap(pixels, 3072, 2048, Bitmap.Config.ARGB_8888)
        original.outputStream().use { assertTrue(bitmap.compress(Bitmap.CompressFormat.PNG, 100, it)) }
        bitmap.recycle()
        val unchanged = original.readBytes()
        val source = NativeBridge.openNativeDetail(original.path)
        val signal = NativeBridge.createCancellation()
        try {
            val failure = runCatching {
                NativeBridge.renderNativeDetail(source, XmpDocument().serialize(), 0, 0, 3072, 2048, 0, signal)
            }.exceptionOrNull()
            assertNotNull("Full-image output must be refused before allocating the large tile", failure)
            assertTrue(failure!!.message.orEmpty().contains("memory budget"))
            val bounded = NativeBridge.renderNativeDetail(source, XmpDocument().serialize(), 0, 0, 32, 32, 0, signal)
            assertEquals(32, bounded.width)
            bounded.recycle()
        } finally {
            NativeBridge.closeNativeDetail(source)
            NativeBridge.closeCancellation(signal)
        }
        val model = ViewModelProvider(compose.activity)[MapleViewModel::class.java]
        try {
            compose.runOnIdle { model.openSingle(Uri.fromFile(original)) }
            compose.waitUntil(30_000) { model.state.value.canChangeMetadata }
            for (editing in listOf(false, true)) {
                if (editing) {
                    compose.onNodeWithContentDescription("Zoom to Fit").performClick()
                    compose.onNodeWithContentDescription("Edit").performClick()
                    compose.waitUntil(60_000) { model.state.value.canEdit }
                }
                val viewport = compose.onNodeWithTag("photo-viewport")
                viewport.performTouchInput { doubleClick(center) }
                compose.waitUntil(60_000) {
                    model.state.value.nativeDetail != null && !model.state.value.nativeDetailBusy
                }
                compose.onNodeWithTag("native-detail-preview").assertIsDisplayed()
                compose.waitForIdle()
                val bounds = viewport.fetchSemanticsNode().boundsInWindow
                var contrast = 0.0
                var placementError = Double.POSITIVE_INFINITY
                compose.waitUntil(10_000) {
                    val screen = instrumentation.uiAutomation.takeScreenshot()
                    try {
                        val x = bounds.center.x.toInt()
                        val y = bounds.center.y.toInt()
                        contrast = (0 until 32).sumOf { row ->
                            (0 until 31).sumOf { col ->
                                kotlin.math.abs(Color.red(screen.getPixel(x + col - 16, y + row - 16)) -
                                    Color.red(screen.getPixel(x + col - 15, y + row - 16)))
                            }
                        } / (32.0 * 31.0)
                        val frame = model.state.value.nativeDetail!!
                        val sourceX = 1536 - frame.region.x
                        val sourceY = 1024 - frame.region.y
                        // Allow subpixel rounding at the viewport centre, but no
                        // implicit centering of a patch wider than the viewport.
                        placementError = (-1..1).minOf { shiftY -> (-1..1).minOf { shiftX ->
                            (0 until 32).sumOf { row -> (0 until 32).sumOf { col ->
                                kotlin.math.abs(Color.red(screen.getPixel(x + col - 16, y + row - 16)) -
                                    Color.red(frame.bitmap.getPixel(sourceX + col - 16 + shiftX,
                                        sourceY + row - 16 + shiftY)))
                            } } / 1024.0
                        } }
                        contrast > 60 && placementError < 5
                    } finally { screen.recycle() }
                }
                assertTrue("One-pixel source pattern must survive the displayed native window: $contrast", contrast > 60)
                assertTrue("Native patch must retain its source-pixel placement: $placementError", placementError < 5)
                assertNull(model.state.value.nativeDetailError)
            }
            assertArrayEquals(unchanged, original.readBytes())
        } finally { original.delete() }
    }

    @Test fun rawDetailOwnsSourceAfterGpuCloseAndTagsBothDisplayTargets() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val original = File.createTempFile("native-raw-", ".dng", instrumentation.targetContext.cacheDir)
        instrumentation.context.assets.open("source.dng").use { input -> original.outputStream().use(input::copyTo) }
        val bytes = original.readBytes()
        val moved = File(original.path + ".moved")
        val renderer = NativeBridge.createRenderer()
        var editor = 0L
        var source = 0L
        val signal = NativeBridge.createCancellation()
        try {
            val packed = NativeBridge.nativeDimensions(original.path, "dng")
            assertTrue((packed ushr 32) > 0 && packed.toInt() > 0)
            val edge = minOf(32, (packed ushr 32).toInt(), packed.toInt())
            editor = NativeBridge.open(original.path, XmpDocument().serialize(), 512, renderer)
            source = NativeBridge.copyNativeDetail(editor)
            NativeBridge.close(editor)
            editor = 0L
            NativeBridge.closeRenderer(renderer)
            assertTrue(original.renameTo(moved))
            for (target in listOf(0, 1)) {
                val tile = NativeBridge.renderNativeDetail(source, XmpDocument().serialize(), 0, 0, edge, edge, target, signal)
                try {
                    assertEquals(edge, tile.width)
                    assertEquals(edge, tile.height)
                    assertEquals(ColorSpace.get(if (target == 0) ColorSpace.Named.SRGB else ColorSpace.Named.DISPLAY_P3), tile.colorSpace)
                    assertEquals(255, Color.alpha(tile.getPixel(0, 0)))
                } finally { tile.recycle() }
            }
            NativeBridge.setCancellation(signal, true)
            try {
                NativeBridge.renderNativeDetail(source, XmpDocument().serialize(), 0, 0, edge, edge, 0, signal)
                fail("Cancelled native work must not publish a bitmap")
            } catch (failure: RuntimeException) { assertTrue(failure.message.orEmpty().contains("cancel", true)) }
            assertArrayEquals(bytes, moved.readBytes())
        } finally {
            if (editor != 0L) { NativeBridge.close(editor); NativeBridge.closeRenderer(renderer) }
            if (source != 0L) NativeBridge.closeNativeDetail(source)
            NativeBridge.closeCancellation(signal)
            original.delete()
            moved.delete()
        }
    }
}
