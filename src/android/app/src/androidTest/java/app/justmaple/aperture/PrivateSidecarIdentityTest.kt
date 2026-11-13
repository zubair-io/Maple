package app.justmaple.aperture

import android.net.Uri
import androidx.test.platform.app.InstrumentationRegistry
import app.justmaple.aperture.data.PhotoLibrary
import app.justmaple.aperture.data.XmpDocument
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.io.File
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.util.zip.CRC32
import java.util.zip.Deflater
import java.util.zip.DeflaterOutputStream
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class PrivateSidecarIdentityTest {
    @Test
    fun reusedSingleFileUrisKeepEditsBoundToTheirOriginalIdentity() = runBlocking {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val original = File.createTempFile("shared-cache-", ".png", context.filesDir)
        original.writeBytes(png(255, 0, 0))
        assertTrue(original.setLastModified(0))
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
        val metadataOnly =
            File(
                legacy.parentFile,
                PhotoLibrary.digest("private-sidecar-v2:$uri:${firstBytes.size}:0") + ".xmp",
            )
        metadataOnly.writeText(legacyXml)
        try {
            val first = library.single(uri)
            assertNull(library.loadSidecar(first).baseline)
            library.save(first, XmpDocument().withAttribute("crs:Exposure2012", "0.75"), null)
            assertEquals(
                "0.75",
                library.loadSidecar(library.single(uri)).document.attribute("crs:Exposure2012"),
            )
            assertArrayEquals(firstBytes, original.readBytes())
            library.withOriginal(first) { assertArrayEquals(firstBytes, it.readBytes()) }
            val firstThumbnail = library.thumbnailPath(first).readBytes()

            // A provider reuses its URI and omits mtime; its replacement has the same byte count.
            original.writeBytes(png(0, 0, 255))
            assertTrue(original.setLastModified(first.modified))
            val secondBytes = original.readBytes()
            val second = library.single(uri)
            assertEquals(first.size, second.size)
            assertEquals(0L, second.modified)
            assertEquals(first.uri, second.uri)
            assertNotEquals(first.key, second.key)
            assertNull(library.loadSidecar(second).baseline)
            library.withOriginal(second) { assertArrayEquals(secondBytes, it.readBytes()) }
            library.withOriginal(first) { assertArrayEquals(firstBytes, it.readBytes()) }
            assertFalse(firstThumbnail.contentEquals(library.thumbnailPath(second).readBytes()))
            library.save(second, XmpDocument().withAttribute("crs:Exposure2012", "-0.5"), null)
            assertEquals(
                "-0.5",
                library.loadSidecar(library.single(uri)).document.attribute("crs:Exposure2012"),
            )
            assertEquals("0.75", library.loadSidecar(first).document.attribute("crs:Exposure2012"))
            assertArrayEquals(secondBytes, original.readBytes())

            // Reopening identical bytes finds their own edits, never the replacement's edits.
            original.writeBytes(firstBytes)
            assertTrue(original.setLastModified(first.modified))
            val restored = library.single(uri)
            assertEquals(first.key, restored.key)
            assertEquals(
                "0.75",
                library.loadSidecar(restored).document.attribute("crs:Exposure2012"),
            )

            // A stale Photo cannot re-read different provider bytes after its snapshot is evicted.
            library.withOriginal(second) { assertTrue(it.delete()) }
            val missing = runCatching {
                library.withOriginal(second) { it.readBytes() }
            }
                .exceptionOrNull()
            assertTrue(missing?.message.orEmpty().contains("Reopen the photo"))
            assertArrayEquals(firstBytes, original.readBytes())

            // A modification-time change alone also changes the shared identity.
            assertTrue(original.setLastModified(second.modified + 10_000))
            val third = library.single(uri)
            assertEquals(second.size, third.size)
            assertNotEquals(second.key, third.key)
            assertNull(library.loadSidecar(third).baseline)
            assertEquals(legacyXml, legacy.readText())
            assertEquals(legacyXml, metadataOnly.readText())
        } finally {
            original.delete()
            legacy.delete()
            metadataOnly.delete()
        }
    }

    /** Valid RGB PNGs with equal lengths and visibly different pixels. */
    private fun png(red: Int, green: Int, blue: Int): ByteArray {
        val output = ByteArrayOutputStream()
        val data = DataOutputStream(output)
        data.write(byteArrayOf(-119, 80, 78, 71, 13, 10, 26, 10))
        fun chunk(name: String, bytes: ByteArray) {
            val type = name.toByteArray(Charsets.US_ASCII)
            data.writeInt(bytes.size)
            data.write(type)
            data.write(bytes)
            data.writeInt(
                CRC32()
                    .apply {
                        update(type)
                        update(bytes)
                    }
                    .value
                    .toInt()
            )
        }
        chunk(
            "IHDR",
            ByteBuffer.allocate(13).putInt(1).putInt(1).put(8).put(2).put(0).put(0).put(0).array(),
        )
        val pixels = ByteArrayOutputStream()
        val deflater = Deflater(Deflater.NO_COMPRESSION)
        try {
            DeflaterOutputStream(pixels, deflater).use {
                it.write(byteArrayOf(0, red.toByte(), green.toByte(), blue.toByte()))
            }
        } finally {
            deflater.end()
        }
        chunk("IDAT", pixels.toByteArray())
        chunk("IEND", byteArrayOf())
        return output.toByteArray()
    }
}
