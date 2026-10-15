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
    fun authoredDecimalRatingsAreIntegralFiniteAndInRange() {
        for ((input, expected) in
            mapOf(
                "3.0" to 3,
                "5" to 5,
                "-1.0" to -1,
                "3.5" to 0,
                "NaN" to 0,
                "Infinity" to 0,
                "6" to 0,
            )) assertEquals(
            input,
            expected,
            roundTrip(XmpDocument().withAttribute("xmp:Rating", input)).rating,
        )
    }

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

    @Test
    fun namespaceAliasesRoundTripWithoutDuplicatingOwnedAttributes() {
        val foreign =
            "<f:Description xmlns:f='urn:foreign' xmp:Rating='1'>  untouched </f:Description>"
        val nested = "<c:MaskGroup><r:Description c:Exposure2012='-2' /></c:MaskGroup>"
        val source =
            """<x:xmpmeta xmlns:x="adobe:ns:meta/"><r:RDF xmlns:r="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:c="http://ns.adobe.com/camera-raw-settings/1.0/" xmlns:m="http://ns.justmaple.app/photo/1.0/" xmlns:xmp="http://ns.adobe.com/xap/1.0/"><r:Description c:Exposure2012="1" m:Profile="Neutral" xmp:Rating="4">$foreign$nested</r:Description></r:RDF></x:xmpmeta>"""
        val imported = XmpDocument(source)
        assertEquals("1", imported.attribute("crs:Exposure2012"))
        assertEquals("Neutral", imported.attribute("papp:Profile"))
        val edited =
            roundTrip(imported.withField(AdjustmentFields.byName.getValue("exposure"), .75f))
        assertEquals("0.75", edited.attribute("crs:Exposure2012"))
        assertEquals("Neutral", edited.attribute("papp:Profile"))
        assertEquals(4, edited.rating)
        assertTrue(edited.original.contains(foreign))
        assertTrue(edited.original.contains(nested))
        assertFalse(edited.original.contains("c:Exposure2012=\"1\""))
        val reset = roundTrip(edited.withField(AdjustmentFields.byName.getValue("exposure"), 0f))
        assertNull(reset.attribute("crs:Exposure2012"))
        assertTrue(reset.original.contains(nested))
    }

    @Test
    fun defaultRdfNamespacePreservesLexicalDecoysAndForeignDescriptions() {
        val retained =
            "<!-- <Description xmp:Rating='1'/> --><![CDATA[<Description xmp:Rating='2'/>]]><f:Description xmlns:f='urn:foreign' xmp:Rating='3'/>"
        val source =
            """<RDF xmlns="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:xmp="http://ns.adobe.com/xap/1.0/"><Description xmp:Rating="4">$retained</Description></RDF>"""
        assertEquals(4, XmpDocument(source).rating)
        val edited = roundTrip(XmpDocument(source).withAttribute("xmp:Rating", "5"))
        assertEquals(5, edited.rating)
        assertTrue(edited.original.contains(retained))
    }

    @Test
    fun legacyMapleFlagsCanBeUnpickedWithoutResurrectingAnOwnedAlias() {
        for (uri in listOf("http://ns.justmaple.app/1.0/", "https://maple.app/ns/1.0/")) {
            val source =
                XmpDocument.EMPTY.replace(
                    "rdf:about=\"\"",
                    "rdf:about=\"\" xmlns:maple=\"$uri\" maple:Flag=\"pick\" maple:Keep=\"untouched\"",
                )
            assertEquals("pick", XmpDocument(source).attribute("papp:Flag"))
            val unpicked = roundTrip(XmpDocument(source).withAttribute("papp:Flag", null))
            assertNull(unpicked.attribute("papp:Flag"))
            assertFalse(unpicked.original.contains("maple:Flag"))
            assertTrue(unpicked.original.contains("maple:Keep=\"untouched\""))
            val picked = roundTrip(unpicked.withAttribute("papp:Flag", "pick"))
            assertEquals("pick", picked.attribute("papp:Flag"))
            assertFalse(picked.original.contains("maple:Flag"))
            assertNull(roundTrip(picked.withAttribute("papp:Flag", null)).attribute("papp:Flag"))
        }
    }

    @Test
    fun unrelatedEditsPreserveUnstampedForeignAndLegacyWhiteBalanceScales() {
        val foreign =
            XmpDocument.EMPTY.replace(
                "rdf:about=\"\"",
                "rdf:about=\"\" xmlns:c=\"http://ns.adobe.com/camera-raw-settings/1.0/\" c:Temperature=\"6000\" c:Tint=\"5\"",
            )
        val legacy =
            foreign.replace(
                "rdf:about=\"\"",
                "rdf:about=\"\" xmlns:maple=\"https://maple.app/ns/1.0/\"",
            )
        for ((source, version) in listOf(foreign to "5", legacy to "1")) {
            val saved = roundTrip(XmpDocument(source).withAttribute("xmp:Rating", "4"))
            assertEquals(version, saved.attribute("papp:WbScaleVersion"))
            assertEquals("6000", saved.attribute("crs:Temperature"))
            assertEquals("5", saved.attribute("crs:Tint"))
            assertEquals(
                version,
                roundTrip(saved.withAttribute("papp:Flag", "pick"))
                    .attribute("papp:WbScaleVersion"),
            )
            val explicit = roundTrip(XmpDocument(source).withAttribute("papp:WbScaleVersion", "3"))
            assertEquals("3", explicit.attribute("papp:WbScaleVersion"))
        }
    }

    @Test
    fun unicodeAliasesAndEntitiesPreserveUnqualifiedForeignAttributeBytes() {
        val foreign = "note=\" crs:Exposure2012='9' xmp:Rating='1'\""
        val source =
            XmpDocument.EMPTY.replace(
                "rdf:about=\"\"",
                "rdf:about=\"\" xmlns:色=\"http://ns.adobe.com/camera-raw-settings/1.0/\" xmlns:xmp=\"http://ns.adobe.com/xap/1.0/\" $foreign 色:Exposure2012=\"&#x31;\" xmp:Rating=\"&#52;\" xmp:Label=\"A &#38; B &#x1F600;\" xmlns:papp=\"http://ns.justmaple.app/photo/1.0/\" papp:Profile=\"&#78;eutral\"",
            )
        val document = XmpDocument(source)
        assertEquals("1", document.attribute("crs:Exposure2012"))
        assertEquals(4, document.rating)
        assertEquals("A & B 😀", document.attribute("xmp:Label"))
        assertEquals("Neutral", document.attribute("papp:Profile"))
        val saved =
            roundTrip(
                document
                    .withField(AdjustmentFields.byName.getValue("exposure"), .75f)
                    .withAttribute("xmp:Rating", "5")
            )
        assertEquals("0.75", saved.attribute("crs:Exposure2012"))
        assertEquals(5, saved.rating)
        assertEquals("A & B 😀", saved.attribute("xmp:Label"))
        assertEquals("Neutral", saved.attribute("papp:Profile"))
        assertTrue(saved.original.contains(foreign))
        assertFalse(saved.original.contains("色:Exposure2012="))
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
