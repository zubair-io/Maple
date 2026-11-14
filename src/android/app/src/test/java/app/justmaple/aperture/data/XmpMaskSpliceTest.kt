package app.justmaple.aperture.data

import java.io.File
import java.nio.file.Files
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * `XmpDocument`'s mask splice over the repo's real Lightroom and Maple mask sidecars:
 * the native writer's replacement containers land in place, and every byte outside
 * them (foreign elements, unknown mask metadata in untouched containers) survives a
 * write to disk and back.
 */
@RunWith(RobolectricTestRunner::class)
class XmpMaskSpliceTest {
    private val root: File =
        generateSequence(File(requireNotNull(System.getProperty("user.dir")))) { it.parentFile }
            .first { File(it, "AGENTS.md").isFile }

    private fun fixture(name: String) = File(root, "test-fixtures/local-adjustments/$name").readText()

    private fun element(xml: String, tag: String): String =
        xml.substring(xml.indexOf("<$tag>"), xml.indexOf("</$tag>") + "</$tag>".length)

    private val foreign = """<vnd:Note xmlns:vnd="urn:example:vendor">kept &amp; exact</vnd:Note>"""
    private val replacement = "<crs:MaskGroupBasedCorrections><rdf:Seq/></crs:MaskGroupBasedCorrections>"

    /** Lightroom's subtract group, then a foreign element and Maple's radial container with an unknown knob. */
    private fun composite(): String {
        val group = fixture("lightroom-group-subtract.xmp")
        val radial =
            element(fixture("spatial-radial.xmp"), "crs:CircularGradientBasedCorrections")
                .replace("crs:MaskValue=\"1\"", "crs:MaskValue=\"1\" crs:FutureMaskKnob=\"7\"")
        val end = "</crs:MaskGroupBasedCorrections>"
        return group.replace(end, "$end\n   $foreign\n   $radial")
    }

    private fun throughFile(text: String): XmpDocument {
        val folder = Files.createTempDirectory("maple-mask-xmp-").toFile()
        return try {
            val file = File(folder, "photo.xmp")
            file.writeText(text)
            XmpDocument(file.readText())
        } finally {
            folder.deleteRecursively()
        }
    }

    private fun output(containers: List<String>, appended: List<String> = emptyList()) =
        JSONObject().put("containers", JSONArray(containers)).put("appended", JSONArray(appended))

    private fun containers(document: XmpDocument): List<String> =
        document.maskInput().getJSONArray("containers").let { list ->
            (0 until list.length()).map { list.getJSONObject(it).getString("xml") }
        }

    @Test
    fun maskInputCarriesEachContainerVerbatimWithItsScope() {
        val source = composite()
        val document = throughFile(source)
        val input = document.maskInput()
        assertEquals(
            listOf(element(source, "crs:MaskGroupBasedCorrections"), element(source, "crs:CircularGradientBasedCorrections")),
            containers(document),
        )
        val scope = input.getJSONArray("containers").getJSONObject(0).getJSONObject("scope")
        assertEquals("http://ns.adobe.com/camera-raw-settings/1.0/", scope.getString("crs"))
        assertEquals("http://www.w3.org/1999/02/22-rdf-syntax-ns#", scope.getString("rdf"))
        assertTrue(input.isNull("legacy"))
    }

    @Test
    fun replacingOneContainerKeepsEveryOtherByteThroughDisk() {
        val source = composite()
        val document = throughFile(source)
        val group = element(source, "crs:MaskGroupBasedCorrections")
        val radial = element(source, "crs:CircularGradientBasedCorrections")
        val edited = document.withMaskOutput(output(listOf(replacement, radial)))
        assertEquals(document.serialize().replace(group, replacement), edited.serialize())

        val saved = throughFile(edited.serialize())
        assertEquals(listOf(replacement, radial), containers(saved))
        assertTrue(saved.original.contains(foreign))
        assertTrue("Unknown mask metadata stays in the untouched container", saved.original.contains("crs:FutureMaskKnob=\"7\""))
    }

    @Test
    fun removingAContainerDropsOnlyThatElement() {
        val source = composite()
        val document = throughFile(source)
        val radial = element(source, "crs:CircularGradientBasedCorrections")
        val saved = throughFile(document.withMaskOutput(output(listOf("", radial))).serialize())
        assertEquals(listOf(radial), containers(saved))
        assertFalse(saved.original.contains("crs:MaskGroupBasedCorrections"))
        assertTrue(saved.original.contains(foreign))
    }

    @Test
    fun anUnchangedOutputIsNoEdit() {
        val source = composite()
        val document = throughFile(source)
        val same =
            document.withMaskOutput(
                output(listOf(element(source, "crs:MaskGroupBasedCorrections"), element(source, "crs:CircularGradientBasedCorrections")))
            )
        assertEquals(document, same)
        assertNull(same.masks)
        assertEquals(document.serialize(), same.serialize())
    }

    @Test
    fun anAppendedContainerOpensASelfClosingDescriptionAndDropsTheLegacyAttribute() {
        val source =
            """<x:xmpmeta xmlns:x="adobe:ns:meta/">
              | <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
              |  <rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
              |   xmlns:papp="http://ns.justmaple.app/1.0/" crs:Exposure2012="+0.50"
              |   papp:LocalAdjustments="[]"/>
              | </rdf:RDF>
              |</x:xmpmeta>
              |""".trimMargin()
        val document = throughFile(source)
        assertEquals("[]", document.maskInput().getString("legacy"))
        assertTrue(containers(document).isEmpty())

        val saved = throughFile(document.withMaskOutput(output(emptyList(), listOf(replacement))).serialize())
        assertEquals(listOf(replacement), containers(saved))
        assertNull(saved.attribute("papp:LocalAdjustments"))
        assertEquals("+0.50", saved.attribute("crs:Exposure2012"))
        assertTrue(saved.original.contains("</rdf:Description>"))
    }

    @Test
    fun containersUnderADefaultNamespaceAreCollected() {
        val crs = "http://ns.adobe.com/camera-raw-settings/1.0/"
        val own = """<GradientBasedCorrections xmlns="$crs"><rdf:Seq/></GradientBasedCorrections>"""
        val inherited = "<CircularGradientBasedCorrections><rdf:Seq/></CircularGradientBasedCorrections>"
        val source =
            """<x:xmpmeta xmlns:x="adobe:ns:meta/">
              | <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
              |  <rdf:Description rdf:about="">
              |   $own
              |   <f:Other xmlns:f="urn:f"/>
              |  </rdf:Description>
              |  <rdf:Description rdf:about="" xmlns="$crs">
              |   $inherited
              |  </rdf:Description>
              | </rdf:RDF>
              |</x:xmpmeta>
              |""".trimMargin()
        val document = throughFile(source)
        assertEquals(listOf(own, inherited), containers(document))
        val scope = document.maskInput().getJSONArray("containers").getJSONObject(1).getJSONObject("scope")
        assertEquals(crs, scope.getString(""))
    }

    @Test
    fun appendedContainersAreWrittenInTheLastDescriptionsDefaultNamespace() {
        // A carried unprefixed node that resets the default must still undeclare it inside a new group.
        val source =
            """<x:xmpmeta xmlns:x="adobe:ns:meta/">
              | <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
              |  <rdf:Description rdf:about="" xmlns="urn:default">
              |   <Other/>
              |  </rdf:Description>
              | </rdf:RDF>
              |</x:xmpmeta>
              |""".trimMargin()
        val target = throughFile(source).maskInput().getJSONObject("target")
        assertEquals("urn:default", target.getString(""))
        assertEquals("http://ns.adobe.com/camera-raw-settings/1.0/", target.getString("crs"))
    }
}
