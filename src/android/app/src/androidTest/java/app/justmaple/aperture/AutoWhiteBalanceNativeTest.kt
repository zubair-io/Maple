package app.justmaple.aperture

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.justmaple.aperture.data.NativeBridge
import app.justmaple.aperture.data.XmpDocument
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
