package app.justmaple.aperture

import android.graphics.Bitmap
import android.net.Uri
import androidx.test.platform.app.InstrumentationRegistry
import app.justmaple.aperture.data.PhotoLibrary
import app.justmaple.aperture.data.XmpDocument
import java.io.File
import java.security.MessageDigest
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class PrivateSidecarIdentityTest {
    @Test
    fun reusedSingleFileUrisKeepEditsBoundToTheirOriginalIdentity() = runBlocking {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val original = File.createTempFile("shared-cache-", ".png", context.filesDir)
        instrumentation.context.assets.open("rgb-gradient.png").use { input ->
            original.outputStream().use { input.copyTo(it) }
        }
        val firstBytes = original.readBytes()
        val uri = Uri.fromFile(original)
        val library = PhotoLibrary(context)
        val legacy =
            File(
                File(context.filesDir, "sidecars").apply { mkdirs() },
                MessageDigest.getInstance("SHA-256")
                    .digest(uri.toString().toByteArray())
                    .joinToString("") { "%02x".format(it) } + ".xmp",
            )
        val legacyXml = XmpDocument().withAttribute("crs:Exposure2012", "3").serialize()
        legacy.writeText(legacyXml)
        try {
            val first = library.single(uri)
            assertNull(library.loadSidecar(first).baseline)
            library.save(first, XmpDocument().withAttribute("crs:Exposure2012", "0.75"), null)
            assertEquals(
                "0.75",
                library.loadSidecar(library.single(uri)).document.attribute("crs:Exposure2012"),
            )
            assertArrayEquals(firstBytes, original.readBytes())

            // The sharing provider replaces its own cache file at the same URI.
            val bitmap = Bitmap.createBitmap(7, 5, Bitmap.Config.ARGB_8888)
            bitmap.eraseColor(android.graphics.Color.RED)
            original.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            bitmap.recycle()
            assertTrue(original.setLastModified(first.modified + 10_000))
            val secondBytes = original.readBytes()
            val second = library.single(uri)
            assertNotEquals(first.key, second.key)
            assertNull(library.loadSidecar(second).baseline)
            library.save(second, XmpDocument().withAttribute("crs:Exposure2012", "-0.5"), null)
            assertEquals(
                "-0.5",
                library.loadSidecar(library.single(uri)).document.attribute("crs:Exposure2012"),
            )
            assertEquals("0.75", library.loadSidecar(first).document.attribute("crs:Exposure2012"))
            assertArrayEquals(secondBytes, original.readBytes())

            // A modification-time change alone also changes the shared identity.
            assertTrue(original.setLastModified(second.modified + 10_000))
            val third = library.single(uri)
            assertEquals(second.size, third.size)
            assertNotEquals(second.key, third.key)
            assertNull(library.loadSidecar(third).baseline)
            assertEquals(legacyXml, legacy.readText())
        } finally {
            original.delete()
            legacy.delete()
        }
    }
}
