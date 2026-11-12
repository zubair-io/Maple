package app.justmaple.aperture

import app.justmaple.aperture.data.MaskPoint
import app.justmaple.aperture.data.NativeBridge
import app.justmaple.aperture.data.RepairKind
import app.justmaple.aperture.data.RepairSpot
import app.justmaple.aperture.data.XmpDocument
import app.justmaple.aperture.data.parseRepairSpots
import app.justmaple.aperture.data.toJson
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** raw-core's repair codec through the real JNI bridge and `XmpDocument`'s splice. */
class RepairNativeRoundTripTest {
    private val foreign = """<vnd:Note xmlns:vnd="urn:example:vendor">kept &amp; exact</vnd:Note>"""
    private val sidecar =
        """<x:xmpmeta xmlns:x="adobe:ns:meta/">
          | <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
          |  <rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Version="18.7">
          |   <crs:RetouchAreas>
          |    <rdf:Seq>
          |     <rdf:li>
          |      <rdf:Description crs:SpotType="heal" crs:SourceState="sourceAutoComputed" crs:Method="circle"
          |       crs:OffsetX="0.1" crs:OffsetY="0" crs:Opacity="1" crs:Feather="0.5" crs:Seed="77">
          |       <crs:Masks>
          |        <rdf:Seq>
          |         <rdf:li crs:What="Mask/CircularGradient" crs:MaskValue="1" crs:X="0.4" crs:Y="0.5"
          |          crs:Radius="0.02" crs:Flow="1" crs:CenterWeight="0" crs:MaskSyncID="kept"/>
          |        </rdf:Seq>
          |       </crs:Masks>
          |      </rdf:Description>
          |     </rdf:li>
          |    </rdf:Seq>
          |   </crs:RetouchAreas>
          |   $foreign
          |  </rdf:Description>
          | </rdf:RDF>
          |</x:xmpmeta>
          |""".trimMargin()

    private fun read(document: XmpDocument): List<RepairSpot> =
        parseRepairSpots(NativeBridge.retouchRead(document.repairInput().toString()))

    @Test
    fun editingAndAddingSpotsKeepsLightroomMetadataAndForeignBytes() {
        val document = XmpDocument(sidecar)
        val spots = read(document)
        assertEquals(.5f, spots.single().source.x, 1e-5f)
        val added = RepairSpot(RepairKind.Clone, MaskPoint(.7f, .7f), MaskPoint(.8f, .7f), .03f, .5f, 1f)
        val edited = listOf(spots[0].copy(opacity = .5f), added)
        val input = document.repairInput().put("spots", edited.toJson())
        val written = document.withRepairOutput(JSONObject(NativeBridge.retouchWrite(input.toString())), true)
        val saved = XmpDocument(written.serialize())

        val reread = read(saved)
        assertEquals(2, reread.size)
        assertEquals(.5f, reread[0].opacity, 1e-5f)
        assertEquals(RepairKind.Clone, reread[1].kind)
        assertTrue(saved.original.contains(foreign))
        assertTrue(saved.original.contains("crs:Seed=\"77\""))
        assertTrue(saved.original.contains("crs:MaskSyncID=\"kept\""))
        assertEquals("2", saved.attribute("papp:RetouchFrameVersion"))
    }
}
