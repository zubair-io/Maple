package app.justmaple.aperture

import android.net.Uri
import androidx.test.platform.app.InstrumentationRegistry
import app.justmaple.aperture.data.NativeBridge
import app.justmaple.aperture.data.PhotoLibrary
import app.justmaple.aperture.data.XmpDocument
import java.io.File
import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class NativeNamespaceImportTest {
    @Test
    fun aliasedSidecarsReachPreviewEditorModelValidationAndExport() = runBlocking {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val context = instrumentation.targetContext
        val library = PhotoLibrary(context)
        val alias =
            """<r:RDF xmlns:r="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:c="http://ns.adobe.com/camera-raw-settings/1.0/" xmlns:maple="https://maple.app/ns/1.0/"><r:Description c:Exposure2012="0.75" maple:Profile="Neutral" maple:Flag="pick"/></r:RDF>"""
        val canonical =
            XmpDocument()
                .withAttribute("crs:Exposure2012", "0.75")
                .withAttribute("papp:Profile", "Neutral")
                .withAttribute("papp:Flag", "pick")
                .serialize()
        for ((asset, extension) in listOf("source.dng" to ".dng", "rgb-gradient.png" to ".png")) {
            val original = File.createTempFile("native-alias-", extension, context.filesDir)
            val directory =
                File(context.cacheDir, "native-alias-${java.util.UUID.randomUUID()}").apply {
                    mkdirs()
                }
            instrumentation.context.assets.open(asset).use { input ->
                original.outputStream().use { input.copyTo(it) }
            }
            val bytes = original.readBytes()
            try {
                val photo = library.single(Uri.fromFile(original))
                val saved = library.save(photo, XmpDocument(alias), null)
                assertEquals("pick", saved.document.attribute("papp:Flag"))
                assertTrue(saved.document.original.contains("c:Exposure2012=\"0.75\""))
                val loaded = saved.document.original
                val handle = NativeBridge.open(original.absolutePath, loaded, 512)
                assertNotEquals(0L, handle)
                try {
                    assertEquals(
                        .75,
                        JSONObject(NativeBridge.values(handle)).getDouble("exposure"),
                        .0001,
                    )
                    NativeBridge.setModel(handle, alias.replace("0.75", "1.25"))
                    assertEquals(
                        1.25,
                        JSONObject(NativeBridge.values(handle)).getDouble("exposure"),
                        .0001,
                    )
                } finally {
                    NativeBridge.close(handle)
                }
                assertFalse(
                    NativeBridge.rasterCompatible(
                        alias.replace("c:Exposure2012=", "c:Contrast2012=")
                    )
                )
                val expectedThumb = File(directory, "expected-thumb.jpg")
                NativeBridge.thumbnail(
                    original.absolutePath,
                    expectedThumb.absolutePath,
                    canonical,
                    512,
                )
                assertArrayEquals(
                    expectedThumb.readBytes(),
                    library.thumbnail(photo, 512).readBytes(),
                )
                val expectedExport = File(directory, "expected-export.jpg")
                val actualExport = File(directory, "actual-export.jpg")
                NativeBridge.export(original.absolutePath, canonical, expectedExport.absolutePath)
                NativeBridge.export(original.absolutePath, loaded, actualExport.absolutePath)
                assertArrayEquals(expectedExport.readBytes(), actualExport.readBytes())
                if (extension == ".dng") {
                    val foreignWb =
                        """<r:RDF xmlns:r="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:c="http://ns.adobe.com/camera-raw-settings/1.0/"><r:Description c:Temperature="6000" c:Tint="5"/></r:RDF>"""
                    val metadataEdit =
                        XmpDocument(foreignWb).withAttribute("xmp:Rating", "4").serialize()
                    val beforeWb = File(directory, "before-wb.jpg")
                    val afterWb = File(directory, "after-wb.jpg")
                    NativeBridge.export(original.absolutePath, foreignWb, beforeWb.absolutePath)
                    NativeBridge.export(original.absolutePath, metadataEdit, afterWb.absolutePath)
                    assertArrayEquals(
                        "Metadata must retain the imported WB scale",
                        beforeWb.readBytes(),
                        afterWb.readBytes(),
                    )
                }
                assertEquals(loaded, library.loadSidecar(photo).baseline)
                assertArrayEquals(bytes, original.readBytes())
            } finally {
                original.delete()
                directory.deleteRecursively()
            }
        }
    }
}
