package app.justmaple.aperture.data

import app.justmaple.aperture.generated.AdjustmentFields
import java.io.File
import java.nio.file.Files
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class XmpCurvesTest {
    private val sCurve = listOf(CurveKnot(0f, 0f), CurveKnot(.25f, .2f), CurveKnot(.75f, .8f), CurveKnot(1f, 1f))

    private fun roundTrip(document: XmpDocument): XmpDocument {
        val folder = Files.createTempDirectory("maple-curve-xmp-").toFile()
        return try {
            val file = File(folder, "photo.xmp")
            file.writeText(document.serialize())
            XmpDocument(file.readText())
        } finally {
            folder.deleteRecursively()
        }
    }

    private fun assertKnots(expected: List<CurveKnot>, actual: List<CurveKnot>) {
        assertEquals(expected.size, actual.size)
        expected.zip(actual).forEach { (e, a) ->
            assertEquals(e.x, a.x, 1e-6f)
            assertEquals(e.y, a.y, 1e-6f)
        }
    }

    @Test
    fun curvesWriteTheCanonicalSeqInTheWireDomainAndReadBack() {
        val saved =
            roundTrip(
                XmpDocument()
                    .withCurve(PointCurve.SceneLuma, sCurve)
                    .withCurve(PointCurve.DisplayBlue, listOf(CurveKnot(0f, .1f), CurveKnot(1f, .9f)))
                    .withAttribute("papp:ToneCurveMode", "RatioPreserving")
            )
        val xml = saved.original
        assertTrue(xml, xml.contains("<papp:SceneLinearToneCurve>\n"))
        assertTrue(xml.contains("<rdf:li>63.75, 51</rdf:li>"))
        assertTrue(xml.contains("<rdf:li>191.25, 204</rdf:li>"))
        assertTrue(xml.contains("<crs:ToneCurvePV2012Blue>"))
        assertTrue(xml.contains("<rdf:li>0, 25.5</rdf:li>"))
        assertTrue(xml.indexOf("papp:SceneLinearToneCurve>") < xml.indexOf("crs:ToneCurvePV2012Blue>"))
        assertTrue(xml.contains("</rdf:Description>"))
        assertKnots(sCurve, saved.curve(PointCurve.SceneLuma))
        assertKnots(listOf(CurveKnot(0f, .1f), CurveKnot(1f, .9f)), saved.curve(PointCurve.DisplayBlue))
        assertTrue(saved.curve(PointCurve.SceneRed).isEmpty())
        assertEquals("RatioPreserving", saved.attribute("papp:ToneCurveMode"))
    }

    @Test
    fun replacingAndClearingACurveTouchesOnlyThatElement() {
        val foreign = "<f:keep xmlns:f=\"urn:foreign\"><f:x>bytes &amp; more</f:x></f:keep>"
        val look =
            "<crs:Look><rdf:Description crs:Name=\"Look\"><crs:Parameters><rdf:Description>" +
                "<crs:ToneCurvePV2012><rdf:Seq><rdf:li>0, 10</rdf:li><rdf:li>255, 245</rdf:li></rdf:Seq></crs:ToneCurvePV2012>" +
                "</rdf:Description></crs:Parameters></rdf:Description></crs:Look>"
        val source =
            """<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" xmlns:papp="http://ns.justmaple.app/photo/1.0/" crs:Exposure2012="1">
    $foreign
    <papp:SceneLinearToneCurveRed>
      <rdf:Seq>
        <rdf:li>0, 0</rdf:li>
        <rdf:li>128, 150</rdf:li>
        <rdf:li>bad</rdf:li>
        <rdf:li>255, 255</rdf:li>
      </rdf:Seq>
    </papp:SceneLinearToneCurveRed>
    <crs:ToneCurvePV2012>
      <rdf:Seq><rdf:li>0, 0</rdf:li><rdf:li>255, 230</rdf:li></rdf:Seq>
    </crs:ToneCurvePV2012>
    $look
  </rdf:Description>
</rdf:RDF></x:xmpmeta>"""
        val loaded = XmpDocument(source)
        assertKnots(listOf(CurveKnot(0f, 0f), CurveKnot(128f / 255f, 150f / 255f), CurveKnot(1f, 1f)), loaded.curve(PointCurve.SceneRed))
        assertKnots(listOf(CurveKnot(0f, 0f), CurveKnot(1f, 230f / 255f)), loaded.curve(PointCurve.DisplayLuma))

        val edited =
            roundTrip(
                loaded
                    .withCurve(PointCurve.SceneRed, sCurve)
                    .withCurve(PointCurve.DisplayLuma, emptyList())
                    .withField(AdjustmentFields.byName.getValue("exposure"), .5f)
            )
        val xml = edited.original
        assertTrue(xml.contains(foreign))
        assertTrue("Nested look curves are not edits", xml.contains(look))
        assertEquals(1, Regex("<papp:SceneLinearToneCurveRed>").findAll(xml).count())
        assertFalse(xml.contains("128, 150"))
        assertFalse(xml.contains("255, 230"))
        assertKnots(sCurve, edited.curve(PointCurve.SceneRed))
        assertTrue(edited.curve(PointCurve.DisplayLuma).isEmpty())
        assertEquals("0.5", edited.attribute("crs:Exposure2012"))
        assertTrue("Replacement keeps the description's indentation", xml.contains("\n    <papp:SceneLinearToneCurveRed>\n      <rdf:Seq>\n        <rdf:li>0, 0</rdf:li>"))
    }

    @Test
    fun restoringTheLoadedCurveIsNotAnEdit() {
        val original = roundTrip(XmpDocument().withCurve(PointCurve.SceneGreen, sCurve))
        val loaded = XmpDocument(original.original)
        val reverted = loaded.withCurve(PointCurve.SceneGreen, emptyList()).withCurve(PointCurve.SceneGreen, loaded.curve(PointCurve.SceneGreen))
        assertEquals(loaded, reverted)
        assertEquals(loaded.hashCode(), reverted.hashCode())
        assertEquals(loaded.serialize(), reverted.serialize())
        assertNotEquals(loaded, loaded.withCurve(PointCurve.SceneGreen, emptyList()))
    }

    @Test
    fun foreignPrefixesAreReusedAndTheIdentityWritesNothing() {
        val source =
            """<r:RDF xmlns:r="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:c="http://ns.adobe.com/camera-raw-settings/1.0/" xmlns:crs="urn:foreign" xmlns:m="https://maple.app/ns/1.0/"><r:Description c:Exposure2012="1"><m:SceneLinearToneCurve><r:Seq><r:li>0, 0</r:li><r:li>255, 200</r:li></r:Seq></m:SceneLinearToneCurve></r:Description></r:RDF>"""
        val loaded = XmpDocument(source)
        assertKnots(listOf(CurveKnot(0f, 0f), CurveKnot(1f, 200f / 255f)), loaded.curve(PointCurve.SceneLuma))
        val edited = roundTrip(loaded.withCurve(PointCurve.DisplayLuma, sCurve).withCurve(PointCurve.SceneLuma, emptyList()))
        assertTrue(edited.original, edited.original.contains("<c:ToneCurvePV2012>"))
        assertTrue(edited.original.contains("<r:Seq>") && edited.original.contains("<r:li>63.75, 51</r:li>"))
        assertFalse(edited.original.contains("SceneLinearToneCurve"))
        assertKnots(sCurve, edited.curve(PointCurve.DisplayLuma))

        val untouched = roundTrip(XmpDocument().withField(AdjustmentFields.byName.getValue("exposure"), 1f))
        assertFalse(untouched.original.contains("ToneCurve"))
        assertTrue(untouched.original.contains("/>"))
    }

    @Test
    fun leavesInsideOpaqueExtensionsAreNotKnots() {
        // raw-core's `opaque_foreign_and_workflow_records_cannot_override_current_development` input.
        val source =
            """<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:papp="http://ns.justmaple.app/photo/1.0/"><papp:SceneLinearToneCurve><rdf:Seq><f:opaque xmlns:f="urn:foreign"><rdf:li>255, 0</rdf:li></f:opaque><papp:Workflow><rdf:li>128, 0</rdf:li></papp:Workflow><f:li xmlns:f="urn:foreign">64, 0</f:li><rdf:li>0, 0</rdf:li><rdf:li>255, 230</rdf:li></rdf:Seq></papp:SceneLinearToneCurve></rdf:Description></rdf:RDF></x:xmpmeta>"""
        assertKnots(listOf(CurveKnot(0f, 0f), CurveKnot(1f, 230f / 255f)), XmpDocument(source).curve(PointCurve.SceneLuma))
    }

    @Test
    fun onlyThePrimarySubjectsCurvesAreReadAndEdited() {
        // raw-core's `foreign_subject_descriptions_are_ignored_in_both_readers` sibling case.
        val other =
            """<rdf:Description rdf:about="other-subject"
      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      crs:Exposure2012="+2.25"
      crs:Contrast2012="+40">
      <crs:ToneCurvePV2012>
        <rdf:Seq><rdf:li>0, 0</rdf:li><rdf:li>128, 160</rdf:li><rdf:li>255, 255</rdf:li></rdf:Seq>
      </crs:ToneCurvePV2012>
    </rdf:Description>"""
        val source =
            """<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      crs:Exposure2012="+0.50"/>
    $other
  </rdf:RDF>
</x:xmpmeta>"""
        val loaded = XmpDocument(source)
        assertTrue(loaded.curve(PointCurve.DisplayLuma).isEmpty())
        assertEquals("+0.50", loaded.attribute("crs:Exposure2012"))
        assertNull(loaded.attribute("crs:Contrast2012"))
        val edited = roundTrip(loaded.withCurve(PointCurve.DisplayLuma, sCurve).withAttribute("crs:Contrast2012", "10"))
        assertTrue("The other subject is untouched", edited.original.contains(other))
        assertKnots(sCurve, edited.curve(PointCurve.DisplayLuma))
        assertEquals("10", edited.attribute("crs:Contrast2012"))
        val primary = edited.original.substringBefore("<rdf:Description rdf:about=\"other-subject\"")
        assertTrue(primary, primary.contains("<crs:ToneCurvePV2012>") && primary.contains("crs:Contrast2012=\"10\""))
    }

    @Test
    fun theBestScoredAnonymousDescriptionIsThePrimarySubject() {
        val source =
            """<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:nodeID="n1" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Exposure2012="2" crs:Contrast2012="5" crs:Shadows2012="9"/><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Exposure2012="0.6"/><rdf:Description xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Highlights2012="-10"><crs:ToneCurvePV2012><rdf:Seq><rdf:li>0, 0</rdf:li><rdf:li>255, 200</rdf:li></rdf:Seq></crs:ToneCurvePV2012></rdf:Description></rdf:RDF>"""
        val loaded = XmpDocument(source)
        // Anonymous outranks a nodeID subject; the third scores 2 (a flat key and a curve container).
        assertEquals("-10", loaded.attribute("crs:Highlights2012"))
        assertNull(loaded.attribute("crs:Exposure2012"))
        assertKnots(listOf(CurveKnot(0f, 0f), CurveKnot(1f, 200f / 255f)), loaded.curve(PointCurve.DisplayLuma))
    }
}
