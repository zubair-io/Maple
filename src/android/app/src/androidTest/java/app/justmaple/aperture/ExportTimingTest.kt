package app.justmaple.aperture

import android.net.Uri
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.justmaple.aperture.data.*
import app.justmaple.aperture.ui.ExportOptions
import java.io.File
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@TimingBenchmark
@RunWith(AndroidJUnit4::class)
class ExportTimingTest {
    private val context = InstrumentationRegistry.getInstrumentation().targetContext

    @Test
    fun exportingWithTheDefaultOptions() {
        val raw = TimingRaw.file()
        val photo = Photo(Uri.fromFile(raw), raw.name, raw.length(), raw.lastModified(), null)
        val options = ExportOptions()
        val library = PhotoLibrary(context)
        val exporter = PhotoExport(context, library)
        val folders = TimingFolders()
        val destination = folders.fixture.write(folders.fixture.root, "export-timing.jpg", ByteArray(0))
        val rendered = File(context.cacheDir, "export-timing-render.jpg")
        try {
            fun render(): Double {
                rendered.delete()
                return Timing.millis {
                    runBlocking {
                        library.withOriginal(photo) { source ->
                            NativeBridge.exportConfigured(
                                source.absolutePath, XmpDocument().serialize(), rendered.absolutePath,
                                options.format.wireName, options.quality, options.maxEdge, false,
                            )
                        }
                    }
                }.second
            }
            fun total() = Timing.millis { runBlocking { exporter.write(photo, XmpDocument(), destination, false, options) } }.second
            fun copy() =
                Timing.millis {
                    context.contentResolver.openFileDescriptor(destination, "rw")!!.use { target ->
                        android.system.Os.ftruncate(target.fileDescriptor, 0)
                        android.os.ParcelFileDescriptor.AutoCloseOutputStream(
                            android.os.ParcelFileDescriptor.dup(target.fileDescriptor)
                        ).use { output -> rendered.inputStream().use { it.copyTo(output) } }
                    }
                }.second
            render()
            total()
            val renders = mutableListOf<Double>()
            val totals = mutableListOf<Double>()
            val copies = mutableListOf<Double>()
            repeat(Timing.rounds) {
                renders += render()
                copies += copy()
                totals += total()
            }
            assertTrue(folders.fixture.read(destination).size > 32)
            Timing.fact("export.fixture", "file=${raw.name} bytes=${raw.length()} output=${options.format.wireName} quality=${options.quality} outputBytes=${rendered.length()}")
            Timing.report("export.render-only", "ms", renders, "NativeBridge.exportConfigured to a private temp file, original already staged")
            Timing.report("export.total", "ms", totals, "PhotoExport.write: render, then verified copy to the document destination")
            Timing.report("export.copy-direct", "ms", copies, "the staged output copied to the document destination through a read-write descriptor, as PhotoExport does; the difference total minus render is below the render's own spread")
        } finally {
            rendered.delete()
            folders.fixture.close()
        }
    }
}
