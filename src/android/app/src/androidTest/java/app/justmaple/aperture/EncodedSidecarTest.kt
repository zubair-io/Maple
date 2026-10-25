package app.justmaple.aperture

import android.net.Uri
import androidx.test.platform.app.InstrumentationRegistry
import app.justmaple.aperture.data.EditorRenderer
import app.justmaple.aperture.data.PhotoExport
import app.justmaple.aperture.data.PhotoLibrary
import app.justmaple.aperture.data.XmpDocument
import app.justmaple.aperture.data.XmpEncoding
import java.io.File
import java.nio.charset.Charset
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Test

class EncodedSidecarTest {
    @Test
    fun privateSidecarsRetainTheirByteEncodingThroughNativeOpenAndMetadataSaves() = runBlocking {
        val i = InstrumentationRegistry.getInstrumentation()
        val context = i.targetContext
        val library = PhotoLibrary(context)
        val renderer = EditorRenderer(library) {}
        try {
            for ((name, bom, label) in
                listOf(
                    Triple("UTF-16LE", byteArrayOf(-1, -2), "UTF-16"),
                    Triple("UTF-32BE", byteArrayOf(0, 0, -2, -1), "UTF-32"),
                    Triple("ISO-8859-1", byteArrayOf(), "ISO-8859-1"),
                )) {
                val original = File.createTempFile("encoded-source-", ".png", context.filesDir)
                i.context.assets.open("rgb-gradient.png").use { input ->
                    original.outputStream().use { input.copyTo(it) }
                }
                val originalBytes = original.readBytes()
                val photo = library.single(Uri.fromFile(original))
                val sidecar =
                    File(
                        File(context.filesDir, "sidecars").apply { mkdirs() },
                        PhotoLibrary.digest("private-sidecar-v3:${photo.key}") + ".xmp",
                    )
                val foreign =
                    "<f:opaque xmlns:f='urn:foreign'>café &amp; light\r\n unchanged</f:opaque>"
                val source =
                    "<?xml version='1.0' encoding='$label'?><r:RDF xmlns:r='http://www.w3.org/1999/02/22-rdf-syntax-ns#' xmlns:c='http://ns.adobe.com/camera-raw-settings/1.0/'><r:Description c:Exposure2012='0.25'>$foreign</r:Description></r:RDF>"
                try {
                    val charset = Charset.forName(name)
                    sidecar.writeBytes(bom + source.toByteArray(charset))
                    val loaded = library.loadSidecar(photo)
                    val values = renderer.open(original.path, loaded.document.serialize(), 512, 1)
                    assertEquals(.25f, values.getValue("exposure"), .001f)
                    val saved =
                        library.save(
                            photo,
                            loaded.document.withAttribute("xmp:Rating", "4"),
                            loaded.baseline,
                        )
                    assertEquals(4, library.loadSidecar(photo).document.rating)
                    val bytes = sidecar.readBytes()
                    assertArrayEquals(bom, bytes.take(bom.size).toByteArray())
                    assertTrue(
                        bytes.toList().windowed(foreign.toByteArray(charset).size).any {
                            it.toByteArray().contentEquals(foreign.toByteArray(charset))
                        }
                    )
                    val export = File.createTempFile("encoded-export-", ".jpg", context.cacheDir)
                    val xmp = File.createTempFile("encoded-export-", ".xmp", context.cacheDir)
                    try {
                        val exporter = PhotoExport(context, library)
                        exporter.write(photo, saved.document, Uri.fromFile(export), false)
                        assertTrue(export.length() > 0)
                        exporter.write(photo, saved.document, Uri.fromFile(xmp), true)
                        val exported = xmp.readBytes()
                        assertArrayEquals(bom, exported.take(bom.size).toByteArray())
                        assertTrue(
                            exported.toList().windowed(foreign.toByteArray(charset).size).any {
                                it.toByteArray().contentEquals(foreign.toByteArray(charset))
                            }
                        )
                        assertEquals(4, XmpDocument(XmpEncoding.decode(exported)).rating)
                        if (name == "ISO-8859-1") {
                            val before = xmp.readBytes()
                            assertTrue(
                                runCatching {
                                    exporter.write(
                                        photo,
                                        saved.document.withAttribute("xmp:Label", "😀"),
                                        Uri.fromFile(xmp),
                                        true,
                                    )
                                }
                                    .isFailure
                            )
                            assertArrayEquals(before, xmp.readBytes())
                        }
                    } finally {
                        export.delete()
                        xmp.delete()
                    }
                    assertArrayEquals(originalBytes, original.readBytes())
                } finally {
                    sidecar.delete()
                    original.delete()
                }
            }
        } finally {
            renderer.close()
        }
    }
}
