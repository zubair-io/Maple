package app.justmaple.aperture

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.justmaple.aperture.data.NativeBridge
import app.justmaple.aperture.data.XmpDocument
import app.justmaple.aperture.ui.forCropPreview
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AutoWhiteBalanceNativeTest {
    @Test
    fun analysisOwnsItsRawAfterTheGpuSessionClosesAndTheInputMoves() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val input = File.createTempFile("auto-wb-native-", ".dng", instrumentation.targetContext.cacheDir)
        instrumentation.context.assets.open("source.dng").use { source -> input.outputStream().use(source::copyTo) }
        val original = input.readBytes()
        val moved = File(input.parentFile, input.name + ".moved")
        val executor = Executors.newSingleThreadExecutor()
        var renderer = 0L
        var handle = 0L
        try {
            renderer = NativeBridge.createRenderer()
            handle = NativeBridge.open(input.absolutePath, XmpDocument().serialize(), 512, renderer)
            val work = NativeBridge.createAutoWhiteBalance(handle, XmpDocument().serialize())
            assertNotEquals(0L, work)
            NativeBridge.close(handle)
            handle = 0L
            NativeBridge.closeRenderer(renderer)
            renderer = 0L
            assertTrue(input.renameTo(moved))
            val result = executor.submit<String> {
                try { NativeBridge.runAutoWhiteBalance(work) }
                finally { NativeBridge.closeAutoWhiteBalance(work) }
            }.get(30, TimeUnit.SECONDS)
            val values = JSONObject(result)
            assertTrue(values.getDouble("temperature").isFinite())
            assertTrue(values.getDouble("tint").isFinite())
            assertTrue(values.getDouble("algorithmVersion") > 0)
            assertArrayEquals(original, moved.readBytes())
        } finally {
            if (handle != 0L) NativeBridge.close(handle)
            if (renderer != 0L) NativeBridge.closeRenderer(renderer)
            executor.shutdown()
            input.delete()
            moved.delete()
        }
    }

    @Test
    fun cropPresentationUsesTheOrientedWholeImageWithoutChangingTheStoredModel() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val input = File.createTempFile("crop-native-", ".dng", instrumentation.targetContext.cacheDir)
        instrumentation.context.assets.open("source.dng").use { source -> input.outputStream().use(source::copyTo) }
        val original = input.readBytes()
        val renderer = NativeBridge.createRenderer()
        var handle = 0L
        val crop = XmpDocument().withAttribute("crs:HasCrop", "True")
            .withAttribute("crs:CropLeft", "0.25").withAttribute("crs:CropRight", "0.75")
        try {
            handle = NativeBridge.open(input.absolutePath, crop.serialize(), 512, renderer)
            val cropped = JSONObject(NativeBridge.values(handle))
            val whole = cropped.getDouble("_uncropped_aspect")
            assertEquals(whole * 0.5, cropped.getDouble("_aspect"), 0.01)
            NativeBridge.setModel(handle, crop.forCropPreview().serialize())
            val presentation = JSONObject(NativeBridge.values(handle))
            assertEquals(whole, presentation.getDouble("_aspect"), 0.001)
            NativeBridge.setModel(handle, crop.serialize())
            assertEquals(cropped.getDouble("_aspect"), JSONObject(NativeBridge.values(handle)).getDouble("_aspect"), 0.001)
            assertArrayEquals(original, input.readBytes())
        } finally {
            if (handle != 0L) NativeBridge.close(handle)
            NativeBridge.closeRenderer(renderer)
            input.delete()
        }
    }

    @Test
    fun parametricPlotUsesTheSharedCurveAndItsCanonicalIdentityBypass() {
        val identity = org.json.JSONArray(NativeBridge.parametricCurve(XmpDocument().serialize()))
        assertEquals(129, identity.length())
        for (index in 0 until identity.length()) {
            val point = identity.getJSONArray(index)
            assertEquals(point.getDouble(0), point.getDouble(1), 1e-7)
        }
        val model = XmpDocument().withAttribute("crs:ParametricShadows", "70")
            .withAttribute("crs:ParametricDarks", "-45").withAttribute("crs:ParametricLights", "30")
            .withAttribute("crs:ParametricHighlights", "-80").withAttribute("crs:ParametricShadowSplit", "18")
            .withAttribute("crs:ParametricMidtoneSplit", "45").withAttribute("crs:ParametricHighlightSplit", "82")
        val mixed = org.json.JSONArray(NativeBridge.parametricCurve(model.serialize()))
        var last = -1.0
        var changed = false
        for (index in 0 until mixed.length()) {
            val point = mixed.getJSONArray(index)
            val x = point.getDouble(0)
            val y = point.getDouble(1)
            assertTrue(y.isFinite() && y >= last && y in 0.0..1.0)
            changed = changed || kotlin.math.abs(x - y) > 0.001
            last = y
        }
        assertTrue(changed)
    }

    @Test
    fun autoWhiteBalanceExplicitlyRefusesRasterInputs() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val input = File.createTempFile("auto-wb-raster-", ".png", instrumentation.targetContext.cacheDir)
        instrumentation.context.assets.open("rgb-gradient.png").use { source -> input.outputStream().use(source::copyTo) }
        val renderer = NativeBridge.createRenderer()
        var handle = 0L
        try {
            handle = NativeBridge.open(input.absolutePath, XmpDocument().serialize(), 512, renderer)
            try {
                NativeBridge.createAutoWhiteBalance(handle, XmpDocument().serialize())
                fail("Auto white balance must not pretend to analyze a raster")
            } catch (error: RuntimeException) { assertTrue(error.message.orEmpty().contains("RAW")) }
        } finally {
            if (handle != 0L) NativeBridge.close(handle)
            NativeBridge.closeRenderer(renderer)
            input.delete()
        }
    }
}
