package app.justmaple.aperture

import app.justmaple.aperture.data.LinearMask
import app.justmaple.aperture.data.MaskLayer
import app.justmaple.aperture.data.NativeBridge
import app.justmaple.aperture.data.RadialMask
import app.justmaple.aperture.data.XmpDocument
import app.justmaple.aperture.data.parseMaskLayers
import app.justmaple.aperture.data.toJson
import app.justmaple.aperture.ui.defaultLinearMask
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

/** raw-core's mask codec through the real JNI bridge and `XmpDocument`'s splice. */
class MaskNativeRoundTripTest {
    private val foreign = """<vnd:Note xmlns:vnd="urn:example:vendor">kept &amp; exact</vnd:Note>"""
    private val sidecar =
        """<x:xmpmeta xmlns:x="adobe:ns:meta/">
          | <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
          |  <rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" crs:Version="11.0">
          |   <crs:CircularGradientBasedCorrections>
          |    <rdf:Seq>
          |     <rdf:li>
          |      <rdf:Description crs:What="Correction" crs:CorrectionAmount="1" crs:CorrectionActive="True"
          |       crs:LocalExposure2012="0.35">
          |       <crs:CorrectionMasks>
          |        <rdf:Seq>
          |         <rdf:li crs:What="Mask/CircularGradient" crs:MaskValue="1" crs:FutureMaskKnob="7"
          |          crs:Top="0.25" crs:Left="0.2" crs:Bottom="0.75" crs:Right="0.8" crs:Angle="0"
          |          crs:Midpoint="50" crs:Roundness="0" crs:Feather="50" crs:Flipped="False"/>
          |        </rdf:Seq>
          |       </crs:CorrectionMasks>
          |      </rdf:Description>
          |     </rdf:li>
          |    </rdf:Seq>
          |   </crs:CircularGradientBasedCorrections>
          |   $foreign
          |  </rdf:Description>
          | </rdf:RDF>
          |</x:xmpmeta>
          |""".trimMargin()

    private fun read(document: XmpDocument): List<MaskLayer> =
        parseMaskLayers(NativeBridge.masksRead(document.maskInput().toString()))

    @Test
    fun addingALayerKeepsTheReadLayerForeignBytesAndUnknownMaskMetadata() {
        val document = XmpDocument(sidecar)
        val layers = read(document)
        assertTrue(layers.single().shape is RadialMask)
        val linear = MaskLayer(defaultLinearMask(), mapOf("exposure" to 1f))
        val input = document.maskInput().put("layers", (layers + linear).toJson())
        val written = document.withMaskOutput(JSONObject(NativeBridge.masksWrite(input.toString())))
        val saved = XmpDocument(written.serialize())

        val reread = read(saved)
        assertEquals(2, reread.size)
        assertEquals(layers[0].shape, reread[0].shape)
        val shape = reread[1].shape as LinearMask
        assertEquals(linear.shape.feather, shape.feather, 1e-4f)
        assertEquals(1f, reread[1].adjustments.getValue("exposure"), 1e-4f)
        assertTrue(saved.original.contains(foreign))
        assertTrue(saved.original.contains("crs:FutureMaskKnob=\"7\""))
    }

    @Test
    fun weightsAndTheUncroppedFrameMapComeFromRawCore() {
        val layer = MaskLayer(defaultLinearMask())
        val weights = NativeBridge.maskWeights(layer.toJson().toString(), 16, 16)
        assertEquals(256, weights.size)
        val top = weights[0].toInt() and 0xFF
        val bottom = weights[255].toInt() and 0xFF
        assertNotEquals("A gradient weighs its two ends differently", top, bottom)
        val frame = NativeBridge.maskFrame(4000, 3000, 0f, 0f, 1f, 1f, 0f, floatArrayOf(0f, 0f, 0f, 100f, 0f, 0f, 0f))
        doubleArrayOf(1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0).forEachIndexed { i, expected ->
            assertEquals(expected, frame[i], 1e-6)
        }
        val offset = NativeBridge.maskFrame(4000, 3000, 0f, 0f, 1f, 1f, 0f, floatArrayOf(0f, 0f, 0f, 100f, 0f, 50f, 0f))
        assertEquals("An X offset of 50 shifts the frame a quarter width", -.25, offset[2], 1e-6)
    }
}
