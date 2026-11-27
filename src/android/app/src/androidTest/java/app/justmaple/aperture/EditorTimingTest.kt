package app.justmaple.aperture

import android.net.Uri
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.ViewGroup
import androidx.activity.ComponentActivity
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.justmaple.aperture.data.*
import app.justmaple.aperture.generated.AdjustmentFields
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@TimingBenchmark
@RunWith(AndroidJUnit4::class)
class EditorTimingTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val raw = TimingRaw.file()
    private val photo = Photo(Uri.fromFile(raw), raw.name, raw.length(), raw.lastModified(), null)
    private val document = XmpDocument().serialize()

    private companion object {
        const val WARMUP_CALLS = 20_000
    }

    private class Window(val view: SurfaceView, val width: Int, val height: Int)

    @Test
    fun openingThePhotoAndTickingASlider() {
        val size = NativeImageSize.unpack(NativeBridge.nativeDimensions(raw.path, photo.extension))
        Timing.fact(
            "editor.fixture",
            "file=${raw.name} bytes=${raw.length()} width=${size.width} height=${size.height} " +
                "megapixels=${"%.1f".format(size.width * size.height / 1e6)}",
        )
        ActivityScenario.launch(ComponentActivity::class.java).use { scenario ->
            val window = attachSurface(scenario)
            Timing.fact("editor.surface", "width=${window.width} height=${window.height}")
            val presented = arrayOf(CountDownLatch(1))
            val publishedFrames = AtomicInteger()
            val library = PhotoLibrary(context)
            val renderer =
                EditorRenderer(library) {
                    publishedFrames.incrementAndGet()
                    presented[0].countDown()
                }
            try {
                val copyAndOpen = mutableListOf<Double>()
                val openOnly = mutableListOf<Double>()
                val warmOpen = mutableListOf<Double>()
                val firstTicks = mutableListOf<Double>()
                val ticks = mutableListOf<Double>()
                val originals = File(context.cacheDir, "originals")
                for (round in 0 until Timing.rounds) {
                    originals.deleteRecursively()
                    presented[0] = CountDownLatch(1)
                    val (opened, total) =
                        Timing.millis {
                            runBlocking {
                                renderer.recordSurface(window.view.holder.surface, window.width, window.height)
                                library.withPreview(photo, 2048) { input ->
                                    Timing.millis { renderer.open(input.absolutePath, document, 2048, round + 1) }
                                }
                            }
                        }
                    val (values, openMillis) = opened
                    assertTrue("The first frame must be presented", presented[0].await(60, TimeUnit.SECONDS))
                    copyAndOpen += total
                    openOnly += openMillis
                    presented[0] = CountDownLatch(1)
                    warmOpen +=
                        Timing.millis {
                                runBlocking {
                                    library.withPreview(photo, 2048) { input ->
                                        renderer.open(input.absolutePath, document, 2048, round + 100)
                                    }
                                }
                            }
                            .second
                    assertTrue("The warm open must present its first frame", presented[0].await(60, TimeUnit.SECONDS))
                    val exposure = checkNotNull(values["exposure"])
                    val tickValues =
                        List(Timing.argument("timingTicks")?.toInt() ?: 40) { index ->
                            val next = values + ("exposure" to exposure + (index % 20 - 10) * .1f)
                            Timing.millis { runBlocking { renderer.draw(next, renderer.revision, document) } }.second
                        }
                    firstTicks += tickValues.first()
                    ticks += tickValues.drop(1)
                }
                Timing.reportFirstAndLater(
                    "editor.open.copy-and-first-frame", "ms", copyAndOpen,
                    "withPreview copy of the original into the private cache plus open plus first presented frame, 2048 px edge; " +
                        "the first round also pays the one-time pipeline creation",
                )
                Timing.reportFirstAndLater(
                    "editor.open.native-open-and-first-frame", "ms", openOnly,
                    "renderer.open alone on the render thread, includes the first frame; the first round also pays the one-time pipeline creation",
                )
                Timing.report("editor.open.warm-original-and-first-frame", "ms", warmOpen,
                    "original already in the private cache")
                Timing.report("editor.tick.first-after-open", "ms", firstTicks)
                Timing.report("editor.tick.steady", "ms", ticks,
                    "renderer.draw: one changed field plus render and present, ${ticks.size} ticks pooled")
                assertTrue("The renderer must have presented a frame", renderer.hasPresented && publishedFrames.get() > 0)
                assertTrue("The surface must still be valid after the ticks", window.view.holder.surface.isValid)
                Timing.fact(
                    "editor.frames",
                    "published=${publishedFrames.get()} note=\"counts the first frame after each open; ticks publish no event, " +
                        "so the check is that a frame was presented and the surface stayed valid\"",
                )
            } finally {
                renderer.close()
            }
        }
    }

    @Test
    fun crossingTheJniBoundary() {
        val size = NativeImageSize.unpack(NativeBridge.nativeDimensions(raw.path, photo.extension))
        Timing.fact("jni.fixture", "file=${raw.name} width=${size.width} height=${size.height}")
        val callsPerRound = 20_000
        val renderer = NativeBridge.createRenderer()
        val handle = NativeBridge.open(raw.path, XmpDocument().serialize(), 2048, renderer)
        val avif = File(context.cacheDir, "timing-boundary.avif")
        try {
            NativeBridge.sharedDerivative(raw.path, avif.path, "", false)
            val exposure = AdjustmentFields.all.first { it.name == "exposure" }.index
            fun perCall(name: String, note: String, call: (Int) -> Unit) {
                repeat(WARMUP_CALLS, call)
                val rounds = List(Timing.rounds) {
                    Timing.millis { repeat(callsPerRound, call) }.second * 1000 / callsPerRound
                }
                Timing.report("jni.$name", "us_per_call", rounds, note)
            }
            perCall("constant-no-arguments", "cropOverlayOverscan: returns a double, no work") { _ ->
                NativeBridge.cropOverlayOverscan()
            }
            perCall("set-field", "setField(handle, index, value) alternating two values: the per-tick call that pushes one changed slider") { call ->
                NativeBridge.setField(handle, exposure, if (call % 2 == 0) 0f else 1f)
            }
            android.os.ParcelFileDescriptor.open(avif, android.os.ParcelFileDescriptor.MODE_READ_ONLY).use {
                perCall("file-descriptor", "cacheValid(fd, 512, avif): passes a descriptor, validates the AVIF header") { _ ->
                    NativeBridge.cacheValid(it.fd, 512, "avif")
                }
            }
            perCall("path-string", "nativeDimensions(path, ext): passes a path string, reads the RAW header") { _ ->
                NativeBridge.nativeDimensions(raw.path, photo.extension)
            }
        } finally {
            NativeBridge.close(handle)
            NativeBridge.closeRenderer(renderer)
            avif.delete()
        }
    }

    private fun attachSurface(scenario: ActivityScenario<ComponentActivity>): Window {
        val ready = CountDownLatch(1)
        var window: Window? = null
        scenario.onActivity { activity ->
            val view = SurfaceView(activity)
            view.holder.addCallback(
                object : SurfaceHolder.Callback {
                    override fun surfaceCreated(holder: SurfaceHolder) = Unit

                    override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
                        window = Window(view, width, height)
                        ready.countDown()
                    }

                    override fun surfaceDestroyed(holder: SurfaceHolder) = Unit
                }
            )
            activity.setContentView(
                view,
                ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
            )
        }
        assertTrue("The surface must be created", ready.await(30, TimeUnit.SECONDS))
        return checkNotNull(window)
    }
}
