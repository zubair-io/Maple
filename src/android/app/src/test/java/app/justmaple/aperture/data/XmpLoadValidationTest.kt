package app.justmaple.aperture.data

import java.nio.file.Files
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class XmpLoadValidationTest {
    @Test
    fun loadingRequiresRdfDescriptionBeforeAnySerialization() {
        val directory = Files.createTempDirectory("xmp-load-validation-").toFile()
        val file = directory.resolve("photo.xmp")
        val original =
            "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\"><rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\"/></x:xmpmeta>"
        try {
            file.writeText(original)
            assertThrows(IllegalArgumentException::class.java) { XmpDocument(file.readText()) }
            assertEquals(original, file.readText())
            file.writeText(XmpDocument.EMPTY)
            val loaded = XmpDocument(file.readText())
            assertEquals(XmpDocument.EMPTY, loaded.original)
            assertEquals("0", loaded.attribute("xmp:Rating") ?: "0")
        } finally {
            directory.deleteRecursively()
        }
    }
}
