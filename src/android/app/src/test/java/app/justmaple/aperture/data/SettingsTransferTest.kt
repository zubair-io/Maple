package app.justmaple.aperture.data

import app.justmaple.aperture.generated.AdjustmentTransfer
import java.io.File
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** Paste through real sidecar files: write, read back, paste, write, read back. */
@RunWith(RobolectricTestRunner::class)
class SettingsTransferTest {
    private val folder = Files.createTempDirectory("maple-paste-").toFile()

    @After fun tearDown() { folder.deleteRecursively() }

    private fun group(id: String) = AdjustmentTransfer.groups.single { it.id == id }

    private fun sidecar(name: String, xml: String): XmpDocument =
        File(folder, name).apply { writeText(xml) }.let { XmpDocument(it.readText()) }

    private fun saved(name: String, document: XmpDocument): String =
        File(folder, name).apply { writeText(document.serialize()) }.readText()

    private fun packet(attributes: String, body: String) =
        """<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
      xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
      xmlns:papp="http://ns.justmaple.app/photo/1.0/"
      xmlns:f="urn:foreign"
      $attributes>
$body
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>"""

    private val sourceXml =
        packet(
            """crs:Temperature="4800" crs:Tint="8" crs:WhiteBalance="Custom" papp:WbSource="Manual"
      papp:WbScaleVersion="5" papp:WbSampleX="0.9" crs:Exposure2012="1.25" crs:Contrast2012="20"
      crs:Saturation="-30" papp:CaptureSharpeningAmount="40" crs:Sharpness="60"
      crs:HasCrop="True" crs:CropTop="0.1" crs:CropLeft="0.1" crs:CropBottom="0.9" crs:CropRight="0.9"
      f:sourceOnly="never travels"""",
            """      <papp:SceneLinearToneCurve>
        <rdf:Seq>
          <rdf:li>0, 0</rdf:li>
          <rdf:li>128, 160</rdf:li>
          <rdf:li>255, 255</rdf:li>
        </rdf:Seq>
      </papp:SceneLinearToneCurve>
      <papp:ColorCurveHueVsSat>
        <rdf:Seq>
          <rdf:li>0, 128</rdf:li>
          <rdf:li>64, 200</rdf:li>
          <rdf:li>255, 128</rdf:li>
        </rdf:Seq>
      </papp:ColorCurveHueVsSat>
      <crs:RetouchAreas><rdf:Seq><rdf:li crs:SpotType="clone" crs:SourceX="0.1"/></rdf:Seq></crs:RetouchAreas>""",
        )

    private val localAdjustments =
        """      <crs:GradientBasedCorrections>
        <rdf:Seq>
          <rdf:li>
            <rdf:Description crs:What="Correction" crs:LocalExposure2012="0.5" crs:CorrectionAmount="1">
              <crs:CorrectionMasks><rdf:Seq><rdf:li crs:What="Mask/Gradient" crs:ZeroX="0.5" crs:ZeroY="0.2" crs:FullX="0.5" crs:FullY="0.6"/></rdf:Seq></crs:CorrectionMasks>
            </rdf:Description>
          </rdf:li>
        </rdf:Seq>
      </crs:GradientBasedCorrections>"""
    private val retouch =
        """      <crs:RetouchAreas><rdf:Seq><rdf:li crs:SpotType="heal" crs:SourceX="0.7"/></rdf:Seq></crs:RetouchAreas>"""
    private val foreign = """      <f:keep><f:x>target bytes &amp; more</f:x></f:keep>"""

    private val targetXml =
        packet(
            """crs:Exposure2012="-0.5" crs:Saturation="10" papp:WbSampleX="0.3" xmp:Rating="4"
      xmlns:xmp="http://ns.adobe.com/xap/1.0/"""",
            """      <crs:ToneCurvePV2012>
        <rdf:Seq>
          <rdf:li>0, 20</rdf:li>
          <rdf:li>255, 235</rdf:li>
        </rdf:Seq>
      </crs:ToneCurvePV2012>
$localAdjustments
$retouch
$foreign""",
        )

    private val copied by lazy { CopiedSettings("source.dng", sidecar("source.xmp", sourceXml)) }

    @Test
    fun pastingSelectedGroupsCopiesTheirValuesAndCurvesAbsolutelyAndNothingElse() {
        val target = sidecar("target.xmp", targetXml)
        val xml = saved("target.xmp", target.pasting(copied, listOf(group("white_balance"), group("tone")), raw = true))
        val pasted = XmpDocument(xml)

        assertEquals("1.25", pasted.attribute("crs:Exposure2012"))
        assertEquals("20", pasted.attribute("crs:Contrast2012"))
        assertEquals("4800", pasted.attribute("crs:Temperature"))
        assertEquals("8", pasted.attribute("crs:Tint"))
        assertEquals("Custom", pasted.attribute("crs:WhiteBalance"))
        assertEquals("Manual", pasted.attribute("papp:WbSource"))
        assertEquals("5", pasted.attribute("papp:WbScaleVersion"))
        assertEquals(copied.document.curve(PointCurve.SceneLuma), pasted.curve(PointCurve.SceneLuma))
        assertEquals(3, pasted.curve(PointCurve.SceneLuma).size)
        assertTrue("Absolute: the source has no display curve", pasted.curve(PointCurve.DisplayLuma).isEmpty())

        assertEquals("Color was not selected", "10", pasted.attribute("crs:Saturation"))
        assertTrue(pasted.curve(PointCurve.HueVsSat).isEmpty())
        assertNull("Geometry was not selected", pasted.attribute("crs:HasCrop"))
        assertEquals("4", pasted.attribute("xmp:Rating"))
        assertEquals("Sample coordinates stay", "0.3", pasted.attribute("papp:WbSampleX"))
        for (block in listOf(localAdjustments, retouch, foreign)) assertTrue(block, xml.contains(block.trim()))
        assertFalse(xml.contains("sourceOnly"))
        assertFalse(xml.contains("SpotType=\"clone\""))
    }

    @Test
    fun colorAndGeometryCarryTheColourCurvesAndCropWhileRasterTargetsSkipRawOnlyDetail() {
        val target = sidecar("target.xmp", targetXml)
        val color = XmpDocument(saved("color.xmp", target.pasting(copied, listOf(group("color"), group("geometry")), raw = true)))
        assertEquals("-30", color.attribute("crs:Saturation"))
        assertEquals(copied.document.curve(PointCurve.HueVsSat), color.curve(PointCurve.HueVsSat))
        assertEquals(listOf("True", "0.1", "0.9"), listOf("crs:HasCrop", "crs:CropTop", "crs:CropRight").map { color.attribute(it) })
        assertEquals("Tone was not selected", "-0.5", color.attribute("crs:Exposure2012"))

        val raster = XmpDocument(saved("raster.xmp", target.pasting(copied, listOf(group("detail")), raw = false)))
        assertEquals("60", raster.attribute("crs:Sharpness"))
        assertNull("Capture sharpening needs a RAW source", raster.attribute("papp:CaptureSharpeningAmount"))
        val rawTarget = target.pasting(copied, listOf(group("detail")), raw = true)
        assertEquals("40", rawTarget.attribute("papp:CaptureSharpeningAmount"))
    }

    @Test
    fun anAsShotSourceReturnsTheTargetToAsShotAndARepeatPasteIsNoChange() {
        val asShot = CopiedSettings("plain.dng", sidecar("plain.xmp", packet("crs:Exposure2012=\"0.3\"", "")))
        val custom = sidecar("custom.xmp", sourceXml)
        val pasted = XmpDocument(saved("custom.xmp", custom.pasting(asShot, listOf(group("white_balance")), raw = true)))
        assertNull(pasted.attribute("crs:Temperature"))
        assertNull(pasted.attribute("crs:Tint"))
        assertNull(pasted.attribute("crs:WhiteBalance"))
        assertNull(pasted.attribute("papp:WbSource"))
        assertEquals("1.25", pasted.attribute("crs:Exposure2012"))

        val once = pasted.pasting(copied, AdjustmentTransfer.groups, raw = true)
        val twice = XmpDocument(once.serialize()).pasting(copied, AdjustmentTransfer.groups, raw = true)
        assertTrue("A repeat paste records no change", twice.changes.isEmpty() && twice.curves.isEmpty())
    }

    @Test
    fun differencesShowCurrentAndIncomingValuesForTheSelectedGroupOnly() {
        val target = sidecar("target.xmp", targetXml)
        val tone = transferDifferences(target, copied, group("tone"), raw = true).associateBy { it.field }
        assertEquals("Exposure", tone.getValue("exposure").label)
        assertEquals("-0.5", tone.getValue("exposure").current)
        assertEquals("1.25", tone.getValue("exposure").incoming)
        assertEquals("0", tone.getValue("contrast").current)
        assertEquals("Linear", tone.getValue("tone_curve_luma").current)
        assertEquals("0,0  128,160  255,255", tone.getValue("tone_curve_luma").incoming)
        assertEquals("0,20  255,235", tone.getValue("display_tone_curve_luma").current)
        assertFalse("Unchanged fields are not listed", "highlights" in tone)
        val wb = transferDifferences(target, copied, group("white_balance"), raw = true).associateBy { it.field }
        assertEquals("As Shot", wb.getValue("temperature").current)
        assertEquals("4800", wb.getValue("temperature").incoming)
        val same = CopiedSettings("target.dng", target)
        assertTrue(AdjustmentTransfer.groups.all { transferDifferences(target, same, it, raw = true).isEmpty() })
    }
}
