package app.justmaple.aperture.data

import java.nio.charset.Charset
import java.nio.file.Files
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class XmpEncodingTest {
    @Test
    fun encodedSidecarsPreserveForeignBytesAndByteOrderThroughRealFileEdits() {
        for ((name, bom, declaration) in
            listOf(
                Triple("UTF-8", byteArrayOf(-17, -69, -65), "UTF-8"),
                Triple("UTF-16LE", byteArrayOf(-1, -2), "UTF-16"),
                Triple("UTF-16BE", byteArrayOf(-2, -1), "UTF-16"),
                Triple("UTF-32LE", byteArrayOf(-1, -2, 0, 0), "UTF-32"),
                Triple("UTF-32BE", byteArrayOf(0, 0, -2, -1), "UTF-32"),
                Triple("ISO-8859-1", byteArrayOf(), "ISO-8859-1"),
            )) {
            val charset = Charset.forName(name)
            val foreign = "<f:data xmlns:f='urn:foreign'> café &amp; light\r\n  preserved </f:data>"
            val source =
                "<?xml\tversion='1.0' encoding='$declaration'?>" +
                    XmpDocument.EMPTY.replace(
                        "rdf:about=\"\" />",
                        "rdf:about=\"\">$foreign</rdf:Description>",
                    )
            val directory = Files.createTempDirectory("maple-encoding-").toFile()
            try {
                val file = java.io.File(directory, "photo.xmp")
                file.writeBytes(bom + source.toByteArray(charset))
                val loaded = XmpDocument(XmpEncoding.decode(file.readBytes()))
                val edited = loaded.withAttribute("xmp:Rating", "4").serialize()
                file.writeBytes(XmpEncoding.encode(edited))
                val bytes = file.readBytes()
                assertArrayEquals(name, bom, bytes.take(bom.size).toByteArray())
                assertTrue(
                    name,
                    bytes.toList().windowed(foreign.toByteArray(charset).size).any {
                        it.toByteArray().contentEquals(foreign.toByteArray(charset))
                    },
                )
                assertEquals(4, XmpDocument(XmpEncoding.decode(bytes)).rating)
            } finally {
                directory.deleteRecursively()
            }
        }
    }

    @Test
    fun bomOnlyAndBomlessWideXmlAcquireAnExplicitMatchingDeclaration() {
        for (name in listOf("UTF-16LE", "UTF-16BE", "UTF-32LE", "UTF-32BE")) {
            val bytes = XmpDocument.EMPTY.toByteArray(Charset.forName(name))
            val xml = XmpEncoding.decode(bytes)
            assertTrue(xml.contains("encoding=\"$name\""))
            assertEquals(
                "Auto",
                XmpDocument(XmpEncoding.decode(XmpEncoding.encode(xml))).serialize().let {
                    XmpDocument(it).attribute("papp:Profile")
                },
            )
        }
    }

    @Test
    fun malformedEncodingAndUnrepresentableEditsFailWithoutReplacementCharacters() {
        // Leave one scratch-buffer slot for a supplementary character that requires two.
        val boundary = "<x>" + "a".repeat(8191 - 3) + "😀 café</x>"
        assertEquals(boundary, XmpEncoding.decode(boundary.toByteArray(Charsets.UTF_8)))
        assertThrows(Exception::class.java) {
            XmpEncoding.decode("a".repeat(8191).toByteArray() + byteArrayOf(-16, -97, -104))
        }
        assertThrows(Exception::class.java) { XmpEncoding.decode(byteArrayOf(60, -1, 62)) }
        assertThrows(Exception::class.java) {
            XmpEncoding.encode("<?xml version='1.0' encoding='ISO-8859-1'?><x>😀</x>")
        }
        assertThrows(Exception::class.java) { XmpEncoding.encode("<x>\uD800</x>") }
        assertThrows(Exception::class.java) {
            XmpEncoding.decode(
                byteArrayOf(-1, -2) +
                    "<?xml version='1.0' encoding='UTF-8'?><x/>"
                        .toByteArray(Charset.forName("UTF-16LE"))
            )
        }
    }

    @Test
    fun cloudTextUsesTheServersUtf8ContractWithUnchangedForeignUnicodeXml() {
        val xml = "<?xml version='1.0' encoding='UTF-16LE'?><x>café 😀</x>"
        assertEquals(
            "<?xml version='1.0' encoding='UTF-8'?><x>café 😀</x>",
            XmpEncoding.forCloud(xml),
        )
    }
}
