package app.justmaple.aperture

import android.net.Uri
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.ViewModelProvider
import androidx.test.platform.app.InstrumentationRegistry
import app.justmaple.aperture.data.XmpDocument
import java.io.File
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test

class ReviewRegressionTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    @Test
    fun openAndShareFiltersOfferOnlySupportedImageFormats() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        for (action in
            listOf(android.content.Intent.ACTION_VIEW, android.content.Intent.ACTION_SEND)) {
            for ((mime, supported) in
                mapOf(
                    "image/jpeg" to true,
                    "image/png" to true,
                    "image/x-canon-cr2" to true,
                    "image/x-canon-crw" to false,
                    "image/gif" to false,
                    "image/bmp" to false,
                    "image/svg+xml" to false,
                    "image/avif" to (android.os.Build.VERSION.SDK_INT >= 31),
                )) {
                val intent =
                    android.content
                        .Intent(action)
                        .setDataAndType(Uri.parse("content://format-fixture/photo"), mime)
                        .setPackage(context.packageName)
                val matches =
                    context.packageManager.queryIntentActivities(
                        intent,
                        android.content.pm.PackageManager.MATCH_DEFAULT_ONLY,
                    )
                assertEquals("$action $mime", supported, matches.isNotEmpty())
            }
        }
    }

    @Test
    fun rasterRejectsRawSlidersAndRecoversAnOldIncompatibleSidecar() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val original = File.createTempFile("review-recovery-", ".png", context.filesDir)
        val bitmap =
            android.graphics.Bitmap.createBitmap(80, 60, android.graphics.Bitmap.Config.ARGB_8888)
        bitmap.eraseColor(android.graphics.Color.rgb(110, 135, 150))
        original.outputStream().use {
            bitmap.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it)
        }
        bitmap.recycle()
        val bytes = original.readBytes()
        val model = ViewModelProvider(compose.activity)[MapleViewModel::class.java]
        val photo = runBlocking { model.library.single(Uri.fromFile(original)) }
        runBlocking {
            model.library.save(
                photo,
                XmpDocument()
                    .withAttribute("crs:Contrast2012", "20")
                    .withAttribute("crs:Exposure2012", "0.5")
                    .withAttribute("xmp:Label", "Retained metadata"),
                null,
            )
        }
        compose.runOnIdle { model.openSingle(photo.uri) }
        compose.waitUntil(30_000) {
            !model.state.value.loading && model.state.value.selected != null
        }
        compose.onNodeWithContentDescription("Edit").performClick()
        compose.waitUntil(30_000) { model.state.value.error?.contains("raster image:") == true }
        compose.onNodeWithText("Reset RAW-only sliders").performClick()
        compose.onNodeWithText("Continue").performClick()
        waitForFrame(model)
        assertEquals(0f, model.state.value.values.getValue("_raw"))
        assertEquals(.5f, model.state.value.values.getValue("exposure"))
        compose.onNodeWithContentDescription("Contrast adjustment").assertDoesNotExist()
        compose.runOnIdle {
            model.setField("contrast", 20f)
            model.setField("whites", 10f)
            model.setField("capture_sharpening_amount", 20f)
        }
        assertFalse(model.state.value.dirty)
        assertEquals(0f, model.state.value.values.getValue("contrast"))
        assertNull(model.state.value.error)
        val baseline = pixel()
        // Undo occurs in the same UI turn as a burst of conflated slider draws.
        compose.runOnIdle {
            for (value in 1..20) model.setField("exposure", value / 10f)
            model.commitGesture()
            model.undo()
        }
        compose.waitUntil(30_000) { !model.state.value.dirty && !model.state.value.saving }
        var stableSince = 0L
        compose.waitUntil(30_000) {
            val same = pixel() == baseline
            if (!same) stableSince = 0
            else if (stableSince == 0L) stableSince = android.os.SystemClock.uptimeMillis()
            same && android.os.SystemClock.uptimeMillis() - stableSince >= 250
        }
        val saved = runBlocking { model.library.loadSidecar(photo) }
        assertEquals("0.5", saved.document.attribute("crs:Exposure2012"))
        assertEquals("Retained metadata", saved.document.attribute("xmp:Label"))
        val destination = File(context.filesDir, "review-recovered.jpg")
        runBlocking { model.export(Uri.fromFile(destination), false) }
        assertTrue(destination.length() > 0)
        assertArrayEquals(bytes, original.readBytes())
    }

    @androidx.test.filters.SdkSuppress(minSdkVersion = 31)
    @Test
    fun avifUsesThePlatformDecoderWithoutChangingItsOriginal() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val original = File(context.filesDir, "review-source.avif")
        instrumentation.context.assets.open("srgb-rgb.avif").use { input ->
            original.outputStream().use { input.copyTo(it) }
        }
        val bytes = original.readBytes()
        val model = ViewModelProvider(compose.activity)[MapleViewModel::class.java]
        compose.runOnIdle { model.openSingle(Uri.fromFile(original)) }
        compose.waitUntil(30_000) {
            !model.state.value.loading && model.state.value.selected != null
        }
        compose.onNodeWithContentDescription("Edit").performClick()
        waitForFrame(model)
        val photo = model.state.value.selected!!
        assertTrue(runBlocking { model.library.thumbnail(photo) }.length() > 0)
        val destination = File(context.filesDir, "review-avif.jpg")
        runBlocking { model.export(Uri.fromFile(destination), false) }
        assertTrue(destination.length() > 0)
        assertArrayEquals(bytes, original.readBytes())
    }

    private fun waitForFrame(model: MapleViewModel) {
        compose.waitUntil(60_000) {
            model.state.value.values.isNotEmpty() && !model.state.value.rendering
        }
        compose.waitForIdle()
        compose.waitUntil(30_000) { !model.state.value.rendering }
        assertNull(model.state.value.error)
    }

    private fun pixel(): Int = renderedPixel(compose.activity)
}
