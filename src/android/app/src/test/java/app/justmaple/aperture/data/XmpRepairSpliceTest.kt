package app.justmaple.aperture.data

import app.justmaple.aperture.generated.AdjustmentFields
import java.io.File
import java.nio.file.Files
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * `XmpDocument`'s repair splice over the repo's Lightroom-shaped repair sidecars: the native
 * writer's replacement `crs:RetouchAreas` lands in place, every byte outside it survives a
 * write to disk and back, and the frame stamp follows raw-core's rule (#4473).
 */
@RunWith(RobolectricTestRunner::class)
class XmpRepairSpliceTest {
    private val root: File =
        generateSequence(File(requireNotNull(System.getProperty("user.dir")))) { it.parentFile }
            .first { File(it, "AGENTS.md").isFile }

    private fun fixture(name: String) = File(root, "test-fixtures/retouch/$name").readText()

    private fun element(xml: String, tag: String): String =
        xml.substring(xml.indexOf("<$tag>"), xml.indexOf("</$tag>") + "</$tag>".length)

    private fun throughFile(text: String): XmpDocument {
        val folder = Files.createTempDirectory("maple-repair-xmp-").toFile()
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
        document.repairInput().getJSONArray("containers").let { list ->
            (0 until list.length()).map { list.getJSONObject(it).getString("xml") }
        }

    private val replacement = "<crs:RetouchAreas><rdf:Seq/></crs:RetouchAreas>"
    private val stamp = "papp:RetouchFrameVersion=\"2\""

    @Test
    fun repairInputCarriesTheContainerVerbatimWithItsScope() {
        val source = fixture("lightroom-spots.xmp")
        val document = throughFile(source)
        assertEquals(listOf(element(source, "crs:RetouchAreas")), containers(document))
        val input = document.repairInput()
        val scope = input.getJSONArray("containers").getJSONObject(0).getJSONObject("scope")
        assertEquals("http://ns.adobe.com/camera-raw-settings/1.0/", scope.getString("crs"))
        assertEquals("urn:example:vendor", scope.getString("vnd"))
        assertEquals(
            "The legacy string list is a repair container too",
            listOf(element(fixture("lightroom-legacy-info.xmp"), "crs:RetouchInfo")),
            containers(throughFile(fixture("lightroom-legacy-info.xmp"))),
        )
    }

    @Test
    fun replacingTheRepairListKeepsEveryOtherByteAndStampsTheFrame() {
        val source = fixture("lightroom-spots.xmp")
        val document = throughFile(source)
        val areas = element(source, "crs:RetouchAreas")
        val edited = document.withRepairOutput(output(listOf(replacement)), hasSpots = true)
        val saved = throughFile(edited.serialize())
        assertEquals(listOf(replacement), containers(saved))
        assertEquals(document.serialize().replace(areas, replacement), edited.serialize())
        assertEquals("2", saved.attribute("papp:RetouchFrameVersion"))
        assertEquals(1, saved.original.split(stamp).size - 1)
        assertTrue(saved.original.contains("<vnd:Keep>outside the repair list</vnd:Keep>"))
        assertEquals("+0.35", saved.attribute("crs:Exposure2012"))

        val emptied = saved.withRepairOutput(output(listOf("")), hasSpots = false)
        val cleared = throughFile(emptied.serialize())
        assertTrue(containers(cleared).isEmpty())
        assertNull("An emptied list carries no frame stamp", cleared.attribute("papp:RetouchFrameVersion"))
        assertTrue(cleared.original.contains("<vnd:Keep>outside the repair list</vnd:Keep>"))
    }

    @Test
    fun anUnrelatedEditStampsAnUprightLightroomListOnce() {
        val source = fixture("lightroom-spots.xmp")
        val exposure = AdjustmentFields.byName.getValue("exposure")
        val saved = throughFile(throughFile(source).withField(exposure, .5f).serialize())
        assertEquals(
            "The Maple markup the save adds would otherwise read the list as the sensor frame",
            "2",
            saved.attribute("papp:RetouchFrameVersion"),
        )
        assertEquals(element(source, "crs:RetouchAreas"), containers(saved).single())
        val again = throughFile(saved.withField(exposure, .25f).serialize())
        assertEquals(1, again.original.split(stamp).size - 1)

        // raw-core never reads an embedded workflow record as Maple authorship.
        val workflow =
            source.replace(
                " <rdf:RDF",
                " <papp:Workflow xmlns:papp=\"http://ns.justmaple.app/photo/1.0/\"><papp:Step papp:Name=\"import\"/></papp:Workflow>\n <rdf:RDF",
            )
        assertEquals("2", throughFile(throughFile(workflow).withField(exposure, .5f).serialize()).attribute("papp:RetouchFrameVersion"))
    }

    @Test
    fun anUnstampedMapleListStaysUnstampedUntilASpotIsEdited() {
        val maple =
            fixture("lightroom-spots.xmp")
                .replace("xmlns:vnd=", "xmlns:papp=\"http://ns.justmaple.app/photo/1.0/\"\n    xmlns:vnd=")
        val exposure = AdjustmentFields.byName.getValue("exposure")
        val saved = throughFile(throughFile(maple).withField(exposure, .5f).serialize())
        assertNull("A legacy sensor-frame list is kept as read", saved.attribute("papp:RetouchFrameVersion"))
        val areas = element(maple, "crs:RetouchAreas")
        val adopted = throughFile(saved.withRepairOutput(output(listOf(areas.replace("0.312500", "0.300000"))), true).serialize())
        assertEquals("2", adopted.attribute("papp:RetouchFrameVersion"))
    }

    @Test
    fun anUnchangedOutputIsNoEditAndAppendedContainersFollowTheMasks() {
        val source = fixture("lightroom-spots.xmp")
        val document = throughFile(source)
        val same = document.withRepairOutput(output(listOf(element(source, "crs:RetouchAreas"))), hasSpots = true)
        assertTrue(same.edits.isEmpty())

        val empty = throughFile(XmpDocument().serialize())
        assertTrue(containers(empty).isEmpty())
        val appended = throughFile(empty.withRepairOutput(output(emptyList(), listOf(replacement)), true).serialize())
        assertEquals(listOf(replacement), containers(appended))
        assertEquals("2", appended.attribute("papp:RetouchFrameVersion"))
    }
}
