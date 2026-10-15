package app.justmaple.aperture.data

import app.justmaple.aperture.generated.AdjustmentFields
import java.io.File
import java.nio.file.Files
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class XmpDocumentTest {
    @Test
    fun globalEditsNeverReadOrRewriteNestedLocalAdjustments() {
        val local =
            "<crs:MaskGroup><rdf:Description crs:Exposure2012='-2' papp:Profile='Neutral' xmp:Rating='1'><crs:Masks><rdf:Seq><rdf:li><rdf:Description crs:Exposure2012='-3' /></rdf:li></rdf:Seq></crs:Masks></rdf:Description></crs:MaskGroup>"
        val source =
            XmpDocument.EMPTY.replace(
                "rdf:about=\"\" />",
                "rdf:about=\"\" xmlns:crs=\"http://ns.adobe.com/camera-raw-settings/1.0/\" xmlns:papp=\"http://ns.justmaple.app/photo/1.0/\" xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\" crs:Exposure2012='1' papp:Profile='Auto' xmp:Rating='4'>$local</rdf:Description>",
            )
        assertEquals("1", XmpDocument(source).attribute("crs:Exposure2012"))
        assertEquals("Auto", XmpDocument(source).attribute("papp:Profile"))
        val edited =
            roundTrip(
                XmpDocument(source)
                    .withField(AdjustmentFields.byName.getValue("exposure"), .75f)
                    .withAttribute("xmp:Rating", "5")
            )
        assertEquals("0.75", edited.attribute("crs:Exposure2012"))
        assertEquals("5", edited.attribute("xmp:Rating"))
        assertTrue(edited.original.contains(local))
        val reset = roundTrip(edited.withField(AdjustmentFields.byName.getValue("exposure"), 0f))
        assertNull(reset.attribute("crs:Exposure2012"))
        assertTrue(reset.original.contains(local))
    }

    @Test
    fun legacyNamespaceIsCanonicalizedWithoutEditingCdata() {
        val foreign =
            "<foreign:data xmlns:foreign=\"urn:foreign\"><![CDATA[<rdf:Description papp:Profile='Keep me'>]]></foreign:data>"
        val source =
            XmpDocument.EMPTY.replace(
                "rdf:about=\"\" />",
                "xmlns:papp=\"http://ns.justmaple.app/1.0/\" rdf:about=\"\">$foreign</rdf:Description>",
            )
        val result =
            roundTrip(
                XmpDocument(source).withField(AdjustmentFields.byName.getValue("exposure"), .75f)
            )
        assertTrue(result.original.contains("xmlns:papp=\"http://ns.justmaple.app/photo/1.0/\""))
        assertTrue(result.original.contains(foreign))
    }

    @Test
    fun unrelatedNamespaceDeclarationsStayInTheirOwnScope() {
        val foreign =
            "<other:data xmlns:other=\"urn:other\" xmlns:papp=\"urn:foreign-papp\">Keep me</other:data>"
        val source = XmpDocument.EMPTY.replace("<rdf:Description", "$foreign<rdf:Description")
        val result = roundTrip(XmpDocument(source).withAttribute("papp:Flag", "pick"))
        assertTrue(result.original.contains(foreign))
        assertEquals("pick", result.attribute("papp:Flag"))
    }

    private fun roundTrip(document: XmpDocument): XmpDocument {
        val folder = Files.createTempDirectory("maple-xmp-").toFile()
        return try {
            val file = File(folder, "photo.xmp")
            file.writeText(document.serialize())
            XmpDocument(file.readText()).also { it.serialize() }
        } finally {
            folder.deleteRecursively()
        }
    }

    @Test
    fun editsPreserveForeignXmlBytesAndExplicitProfile() {
        val foreign =
            "<foreign:data xmlns:foreign=\"urn:foreign\">  café &amp; light\n  </foreign:data>"
        val source =
            XmpDocument.EMPTY.replace(
                "rdf:about=\"\" />",
                "rdf:about=\"\">$foreign</rdf:Description>",
            )
        val result =
            roundTrip(
                XmpDocument(source).withField(AdjustmentFields.byName.getValue("exposure"), 1.25f)
            )
        assertEquals("1.25", result.attribute("crs:Exposure2012"))
        assertEquals("Auto", result.attribute("papp:Profile"))
        assertTrue(result.original.contains(foreign))
    }

    @Test
    fun returningToDefaultRemovesAllAuthoredCopies() {
        val source =
            XmpDocument.EMPTY.replace(
                "rdf:about=\"\"",
                "rdf:about=\"\" xmlns:crs=\"http://ns.adobe.com/camera-raw-settings/1.0/\" crs:Exposure2012='2'",
            )
        val result =
            roundTrip(
                XmpDocument(source).withField(AdjustmentFields.byName.getValue("exposure"), 0f)
            )
        assertNull(result.attribute("crs:Exposure2012"))
        assertEquals("True", result.attribute("crs:HasSettings"))
    }

    @Test
    fun manualWhiteBalanceKeepsAnExplicitDefaultAndVersion() {
        val result =
            roundTrip(
                XmpDocument().withField(AdjustmentFields.byName.getValue("temperature"), 6500f)
            )
        assertEquals("6500", result.attribute("crs:Temperature"))
        assertEquals("Custom", result.attribute("crs:WhiteBalance"))
        assertEquals("5", result.attribute("papp:WbScaleVersion"))
    }

    @Test
    fun metadataEscapesAndKeepsLegacyNeutralIntent() {
        val source =
            XmpDocument.EMPTY.replace(
                "rdf:about=\"\"",
                "rdf:about=\"\" xmlns:papp=\"http://ns.justmaple.app/photo/1.0/\" papp:Look=\"Neutral\"",
            )
        val result = roundTrip(XmpDocument(source).withAttribute("xmp:Label", "A & B \"red\""))
        assertEquals("A & B \"red\"", result.attribute("xmp:Label"))
        assertEquals("Neutral", result.attribute("papp:Profile"))
    }

    @Test
    fun rejectsMalformedXmlAndNonFiniteEdits() {
        assertThrows(Exception::class.java) { XmpDocument("<broken>").serialize() }
        assertThrows(IllegalArgumentException::class.java) {
            XmpDocument().withField(AdjustmentFields.byName.getValue("exposure"), Float.NaN)
        }
    }
}
